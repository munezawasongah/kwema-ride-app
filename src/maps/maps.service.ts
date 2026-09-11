/**
 * Google Maps integration.
 *
 * Everything here is server-side, and that is the point. The mobile apps hold
 * a separate, bundle-restricted key that can only render map tiles; Directions,
 * Distance Matrix, Geocoding and Places all go through this service. Shipping a
 * Directions-capable key in an APK means anyone who unpacks it can spend your
 * Maps budget, and APKs get unpacked.
 *
 * Cost control is a first-class concern, not an optimisation. Directions and
 * Distance Matrix are billed per call, a busy evening in Dar is tens of
 * thousands of quote requests, and riders re-quote constantly as they drag the
 * pin. Three mechanisms hold that down:
 *
 *   1. Route results are cached in Redis on a coordinate grid snapped to ~50 m.
 *      Two riders standing on the same block asking for the same destination
 *      hit one billed call, not two.
 *   2. Distance Matrix is called only for the top few dispatch candidates.
 *      Per-candidate matrix calls would blow both the latency budget and the
 *      bill.
 *   3. A haversine fallback keeps the product working when Maps is unreachable
 *      or the daily cap is hit — a degraded fare estimate beats a dead app.
 */

import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout } from 'rxjs';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';
import { VehicleCategory } from '../dispatch/dispatch.service';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteResult {
  distanceMetres: number;
  durationSeconds: number;
  /** Duration with live traffic, when Google returns it. */
  durationInTrafficSeconds?: number;
  /** Encoded polyline for drawing the route on the rider's map. */
  polyline: string;
  /** True when this came from the fallback estimator, not from Google. */
  isEstimate: boolean;
}

export interface PlaceSuggestion {
  placeId: string;
  primary: string;
  secondary: string;
}

const CACHE_TTL_ROUTE = 300; // 5 min — traffic moves, but not that fast
const CACHE_TTL_PLACE = 86_400;
const GRID_PRECISION = 0.0005; // ~55 m at the equator

/**
 * Bounding box for Tanzania, with a margin. Requests outside it are rejected
 * before they cost anything — it is the cheapest possible abuse filter, and a
 * pickup in another country is always a bug or a probe.
 */
const TZ_BOUNDS = { minLat: -12.0, maxLat: 0.0, minLng: 29.0, maxLng: 41.0 };

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly key = process.env.GOOGLE_MAPS_SERVER_KEY;
  private readonly base = 'https://maps.googleapis.com/maps/api';
  // Places API (New) lives on a different host from the classic endpoints.
  // The legacy place/autocomplete path returns an empty result set — not an
  // error — for projects created after Google's March 2025 legacy cutover,
  // which is exactly how it fails silently.
  private readonly placesBase = 'https://places.googleapis.com';

  constructor(
    private readonly http: HttpService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ===================================================================
  // Routing
  // ===================================================================

  /**
   * Route between two points. This is the authoritative source of distance
   * and duration for a fare quote — the client's own figure is never trusted,
   * because a modified app could otherwise quote a 12 km trip as 2 km.
   */
  async route(
    origin: LatLng,
    destination: LatLng,
    category: VehicleCategory,
  ): Promise<RouteResult> {
    this.assertInBounds(origin, 'origin');
    this.assertInBounds(destination, 'destination');

    const cacheKey = `route:${this.gridKey(origin)}:${this.gridKey(destination)}:${category}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    if (!this.key) return this.estimate(origin, destination, category);

    try {
      const response = await firstValueFrom(
        this.http
          .get(`${this.base}/directions/json`, {
            params: {
              origin: `${origin.lat},${origin.lng}`,
              destination: `${destination.lat},${destination.lng}`,
              key: this.key,
              region: 'tz',
              // Always driving. Google has no motorcycle mode in Tanzania, and
              // bicycling — the obvious proxy — has no route coverage here
              // either: it returns ZERO_RESULTS, which silently dropped every
              // boda quote to the straight-line estimator. A driving route
              // with a boda time factor applied afterwards is both available
              // and closer to reality.
              mode: 'driving',
              departure_time: 'now',
              traffic_model: 'best_guess',
              alternatives: 'false',
            },
          })
          .pipe(timeout(6000)),
      );

      let data = response.data;

      // Google has no bicycling coverage across most of East Africa, so a
      // boda request returns ZERO_RESULTS and every boda quote silently
      // degraded to a straight-line estimate — on the highest-volume tier,
      // which is the worst possible place for it. Retry once in driving mode
      // before giving up on real routing; the time factor below still applies.
      if (isTwoWheeler(category) && data.status !== 'OK') {
        this.logger.warn(
          `bicycling routing unavailable (${data.status}); retrying as driving`,
        );
        const retry = await firstValueFrom(
          this.http
            .get(`${this.base}/directions/json`, {
              params: {
                origin: `${origin.lat},${origin.lng}`,
                destination: `${destination.lat},${destination.lng}`,
                key: this.key,
                region: 'tz',
                mode: 'driving',
                departure_time: 'now',
                traffic_model: 'best_guess',
                alternatives: 'false',
              },
            })
            .pipe(timeout(6000)),
        );
        data = retry.data;
      }

      if (data.status !== 'OK' || !data.routes?.length) {
        this.logger.warn(
          `directions returned ${data.status}` +
            (data.error_message ? `: ${data.error_message}` : '') +
            ' — falling back to estimate',
        );
        return this.estimate(origin, destination, category);
      }

      const leg = data.routes[0].legs[0];

      // A boda filters through traffic a car sits in, so the driving duration
      // overstates its trip time — badly during a Dar peak. This factor is a
      // starting point to be retuned from completed-trip telemetry per city;
      // distance is left alone, since the roads travelled are the same.
      const bodaTimeFactor = category === 'boda' ? 0.7 : 1;
      const scale = (seconds?: number) =>
        seconds === undefined ? undefined : Math.round(seconds * bodaTimeFactor);

      const result: RouteResult = {
        distanceMetres: leg.distance.value,
        durationSeconds: scale(leg.duration.value)!,
        durationInTrafficSeconds: scale(leg.duration_in_traffic?.value),
        polyline: data.routes[0].overview_polyline.points,
        isEstimate: false,
      };

      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_ROUTE);
      return result;
    } catch (err: any) {
      const detail =
        err?.response?.data?.error_message ?? (err as Error).message;
      this.logger.error(`directions failed: ${detail}`);
      return this.estimate(origin, destination, category);
    }
  }

  /**
   * Driving ETA from several drivers to one pickup, in a single billed call.
   * Capped at the dispatch shortlist — Distance Matrix bills per
   * origin-destination pair, so an uncapped call is an uncapped invoice.
   */
  async etaMatrix(
    origins: LatLng[],
    destination: LatLng,
    category: VehicleCategory,
  ): Promise<number[]> {
    if (origins.length === 0) return [];

    const capped = origins.slice(0, 5);
    if (!this.key) {
      return capped.map((o) => this.estimateSeconds(o, destination, category));
    }

    try {
      const response = await firstValueFrom(
        this.http
          .get(`${this.base}/distancematrix/json`, {
            params: {
              origins: capped.map((o) => `${o.lat},${o.lng}`).join('|'),
              destinations: `${destination.lat},${destination.lng}`,
              key: this.key,
              region: 'tz',
              mode: 'driving',
              departure_time: 'now',
            },
          })
          .pipe(timeout(5000)),
      );

      const rows = response.data?.rows ?? [];
      return capped.map((origin, i) => {
        const element = rows[i]?.elements?.[0];
        if (element?.status !== 'OK') {
          return this.estimateSeconds(origin, destination, category);
        }
        return element.duration_in_traffic?.value ?? element.duration.value;
      });
    } catch (err) {
      this.logger.warn(`distance matrix failed: ${(err as Error).message}`);
      return capped.map((o) => this.estimateSeconds(o, destination, category));
    }
  }

  // ===================================================================
  // Places
  // ===================================================================

  /**
   * Destination autocomplete, proxied so the key stays server-side.
   *
   * Results are biased to the rider's current position and restricted to
   * Tanzania. Session tokens matter for billing: Google charges autocomplete
   * per session rather than per keystroke when a token is supplied, and a
   * rider typing "Mlimani" generates seven requests.
   */
  async autocomplete(
    input: string,
    near: LatLng | null,
    sessionToken: string,
    language: string,
  ): Promise<PlaceSuggestion[]> {
    if (input.trim().length < 2) return [];
    if (!this.key) return [];

    const cacheKey = `places:v2:${language}:${input.toLowerCase().trim()}:${
      near ? this.gridKey(near) : 'any'
    }`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const response = await firstValueFrom(
        this.http
          .post(
            `${this.placesBase}/v1/places:autocomplete`,
            {
              input,
              languageCode: ['sw', 'en', 'fr'].includes(language) ? language : 'sw',
              regionCode: 'TZ',
              includedRegionCodes: ['tz'],
              sessionToken,
              ...(near
                ? {
                    locationBias: {
                      circle: {
                        center: { latitude: near.lat, longitude: near.lng },
                        radius: 30000,
                      },
                    },
                  }
                : {}),
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': this.key,
              },
            },
          )
          .pipe(timeout(5000)),
      );

      const suggestions: PlaceSuggestion[] = (response.data?.suggestions ?? [])
        .filter((s: any) => s.placePrediction)
        .map((s: any) => ({
          placeId: s.placePrediction.placeId,
          primary:
            s.placePrediction.structuredFormat?.mainText?.text ??
            s.placePrediction.text?.text ??
            '',
          secondary:
            s.placePrediction.structuredFormat?.secondaryText?.text ?? '',
        }));

      await this.redis.set(
        cacheKey,
        JSON.stringify(suggestions),
        'EX',
        CACHE_TTL_PLACE,
      );
      return suggestions;
    } catch (err: any) {
      // Google's error body names the actual cause (API not enabled, key
      // restriction, billing). Returning an empty array without logging it
      // is what made this failure mode invisible for so long.
      const detail =
        err?.response?.data?.error?.message ?? (err as Error).message;
      this.logger.error(`places autocomplete failed: ${detail}`);
      return [];
    }
  }

  /** Resolves a place id chosen from autocomplete into coordinates. */
  async placeDetails(
    placeId: string,
    sessionToken: string,
  ): Promise<{ point: LatLng; address: string } | null> {
    if (!this.key) return null;

    const cacheKey = `place:v2:detail:${placeId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const response = await firstValueFrom(
        this.http
          .get(`${this.placesBase}/v1/places/${encodeURIComponent(placeId)}`, {
            headers: {
              'X-Goog-Api-Key': this.key,
              // The field mask is mandatory on the new API and also governs
              // billing: request only these three and the call stays in the
              // cheapest SKU tier.
              'X-Goog-FieldMask': 'location,formattedAddress,displayName',
              ...(sessionToken ? { 'X-Goog-Session-Token': sessionToken } : {}),
            },
          })
          .pipe(timeout(5000)),
      );

      const result = response.data;
      if (!result?.location) return null;

      const detail = {
        point: {
          lat: result.location.latitude,
          lng: result.location.longitude,
        },
        address: result.formattedAddress ?? result.displayName?.text ?? '',
      };

      await this.redis.set(cacheKey, JSON.stringify(detail), 'EX', 604_800);
      return detail;
    } catch (err: any) {
      const detail =
        err?.response?.data?.error?.message ?? (err as Error).message;
      this.logger.error(`place details failed: ${detail}`);
      return null;
    }
  }

  /**
   * Reverse geocoding for the pickup pin.
   *
   * Large parts of Dar have no street addresses in Google's data, so a
   * reverse geocode often returns something unhelpfully broad like
   * "Kinondoni". The caller should treat the result as a hint and let the
   * rider type a landmark, which is how people actually give directions here.
   */
  async reverseGeocode(point: LatLng, language: string): Promise<string | null> {
    this.assertInBounds(point, 'point');
    if (!this.key) return null;

    const cacheKey = `geocode:${this.gridKey(point)}:${language}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await firstValueFrom(
        this.http
          .get(`${this.base}/geocode/json`, {
            params: {
              latlng: `${point.lat},${point.lng}`,
              key: this.key,
              language: ['sw', 'en', 'fr'].includes(language) ? language : 'sw',
              result_type: 'street_address|premise|point_of_interest|neighborhood',
            },
          })
          .pipe(timeout(4000)),
      );

      const address = response.data?.results?.[0]?.formatted_address ?? null;
      if (address) await this.redis.set(cacheKey, address, 'EX', 604_800);
      return address;
    } catch (err) {
      this.logger.warn(`reverse geocode failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ===================================================================
  // Diagnostics
  // ===================================================================

  /**
   * Calls each Google API once and reports what came back.
   *
   * This exists because Google's failure modes are quiet. A key that is not
   * authorised for an API returns an empty result set rather than an error,
   * so a misconfigured key is indistinguishable from "no places matched"
   * unless you go looking. This surfaces the real status message.
   *
   * Never returns the key itself — only whether one is configured.
   */
  async diagnostics(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      serverKeyConfigured: Boolean(this.key),
      browserKeyConfigured: Boolean(process.env.GOOGLE_MAPS_BROWSER_KEY),
    };
    if (!this.key) return out;

    const dar = { lat: -6.8161, lng: 39.2894 };
    const mlimani = { lat: -6.7724, lng: 39.2083 };

    // --- Places API (New) ---
    try {
      const r = await firstValueFrom(
        this.http
          .post(
            `${this.placesBase}/v1/places:autocomplete`,
            { input: 'Mlimani', regionCode: 'TZ', includedRegionCodes: ['tz'] },
            { headers: { 'X-Goog-Api-Key': this.key } },
          )
          .pipe(timeout(6000)),
      );
      const n = (r.data?.suggestions ?? []).length;
      out.placesNew = n > 0 ? `ok (${n} results)` : 'reachable but 0 results';
    } catch (err: any) {
      out.placesNew =
        'FAIL: ' + (err?.response?.data?.error?.message ?? err.message);
    }

    // --- Geocoding ---
    try {
      const r = await firstValueFrom(
        this.http
          .get(`${this.base}/geocode/json`, {
            params: { latlng: `${dar.lat},${dar.lng}`, key: this.key },
          })
          .pipe(timeout(6000)),
      );
      out.geocoding =
        r.data?.status === 'OK'
          ? 'ok'
          : `${r.data?.status}: ${r.data?.error_message ?? 'no detail'}`;
    } catch (err: any) {
      out.geocoding = 'FAIL: ' + err.message;
    }

    // --- Directions (legacy SKU) ---
    try {
      const r = await firstValueFrom(
        this.http
          .get(`${this.base}/directions/json`, {
            params: {
              origin: `${mlimani.lat},${mlimani.lng}`,
              destination: `${dar.lat},${dar.lng}`,
              key: this.key,
            },
          })
          .pipe(timeout(6000)),
      );
      out.directions =
        r.data?.status === 'OK'
          ? `ok (${Math.round(r.data.routes[0].legs[0].distance.value / 100) / 10} km)`
          : `${r.data?.status}: ${r.data?.error_message ?? 'no detail'}`;
    } catch (err: any) {
      out.directions = 'FAIL: ' + err.message;
    }

    // --- Distance Matrix (legacy SKU) ---
    try {
      const r = await firstValueFrom(
        this.http
          .get(`${this.base}/distancematrix/json`, {
            params: {
              origins: `${mlimani.lat},${mlimani.lng}`,
              destinations: `${dar.lat},${dar.lng}`,
              key: this.key,
            },
          })
          .pipe(timeout(6000)),
      );
      out.distanceMatrix =
        r.data?.status === 'OK'
          ? `ok (${r.data.rows?.[0]?.elements?.[0]?.status})`
          : `${r.data?.status}: ${r.data?.error_message ?? 'no detail'}`;
    } catch (err: any) {
      out.distanceMatrix = 'FAIL: ' + err.message;
    }

    return out;
  }

  // ===================================================================
  // Fallback estimation
  // ===================================================================

  /**
   * Used when Maps is unreachable. The 1.35 factor converts straight-line to
   * road distance; it is tuned per city from completed-trip telemetry, and
   * Dar's peninsular layout makes it higher than a grid city like Dodoma.
   */
  private estimate(
    origin: LatLng,
    destination: LatLng,
    category: VehicleCategory,
  ): RouteResult {
    const straight = haversineMetres(origin, destination);
    const distanceMetres = Math.round(straight * 1.35);
    return {
      distanceMetres,
      durationSeconds: this.estimateSeconds(origin, destination, category),
      polyline: '',
      isEstimate: true,
    };
  }

  private estimateSeconds(
    origin: LatLng,
    destination: LatLng,
    category: VehicleCategory,
  ): number {
    const speeds: Record<VehicleCategory, number> = {
      boda: 22,
      bajaji: 16,
      standard: 14,
      xl: 13,
      express: 14,
      e_boda: 22,
      e_bajaji: 16,
      e_car: 14,
    };
    const metres = haversineMetres(origin, destination) * 1.35;
    return Math.round(metres / ((speeds[category] * 1000) / 3600));
  }

  // ===================================================================
  // Helpers
  // ===================================================================

  /** Snaps coordinates to a ~55 m grid so nearby requests share a cache key. */
  private gridKey(point: LatLng): string {
    const lat = Math.round(point.lat / GRID_PRECISION) * GRID_PRECISION;
    const lng = Math.round(point.lng / GRID_PRECISION) * GRID_PRECISION;
    return `${lat.toFixed(4)},${lng.toFixed(4)}`;
  }

  private assertInBounds(point: LatLng, label: string): void {
    if (
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lng) ||
      point.lat < TZ_BOUNDS.minLat ||
      point.lat > TZ_BOUNDS.maxLat ||
      point.lng < TZ_BOUNDS.minLng ||
      point.lng > TZ_BOUNDS.maxLng
    ) {
      throw new BadRequestException(`${label} is outside the service area`);
    }
  }
}

/** Motorcycles filter through traffic; an electric one does so identically. */
export function isTwoWheeler(category: VehicleCategory): boolean {
  return category === 'boda' || category === 'e_boda';
}

export function haversineMetres(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
