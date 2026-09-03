/**
 * FareService — fare quoting and settlement.
 *
 * Regulatory position
 *   LATRA sets guide fares per kilometre and per minute, a minimum fare, and
 *   ceilings on operator commission and booking fee. Those ceilings have been
 *   revised more than once by gazette notice (the 2022 order and the December
 *   2022 notice moved them in opposite directions), so nothing here is a
 *   constant: every ceiling is read from the `tariffs` table, versioned by
 *   validity window, and must be reconciled against the notice in force
 *   before go-live and after each gazette.
 *
 * Money
 *   All arithmetic is in integer cents of TZS. Floats are used only for
 *   multipliers, and every multiplication rounds immediately. The final
 *   customer-facing figure is rounded to the nearest 50 TZS, because that is
 *   the smallest note a driver can practically give change for.
 */

import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';
import { VehicleCategory } from '../dispatch/dispatch.service';

export interface Tariff {
  id: string;
  category: VehicleCategory;
  baseFareCents: number;
  perKmCents: number;
  perMinuteCents: number;
  minimumFareCents: number;
  waitingPerMinuteCents: number;
  freeWaitingSeconds: number;
  cancellationFeeCents: number;
  commissionBpsCap: number;
  bookingFeeBpsCap: number;
  maxSurgeMultiplier: number;
  gazetteReference?: string;
}

export interface FareInput {
  category: VehicleCategory;
  distanceMetres: number;
  durationSeconds: number;
  waitingSeconds?: number;
  pickup: { lat: number; lng: number };
  /** Set on settlement; omitted when quoting. */
  isSettlement?: boolean;
  /** Surge locked at quote time so the rider is never charged a higher one. */
  lockedSurge?: number;
  /** Airport/zone pickup surcharge, resolved from service_zones. */
  zoneSurchargeCents?: number;
  promoDiscountCents?: number;
}

export interface FareBreakdown {
  tariffId: string;
  gazetteReference?: string;
  currency: 'TZS';

  baseFareCents: number;
  distanceChargeCents: number;
  timeChargeCents: number;
  waitingChargeCents: number;
  zoneSurchargeCents: number;

  subtotalCents: number;
  surgeMultiplier: number;
  surgeAmountCents: number;
  minimumFareAppliedCents: number;
  promoDiscountCents: number;

  bookingFeeCents: number;
  /** Total the rider pays. */
  totalFareCents: number;

  /** Operator's cut, already capped at the LATRA ceiling. */
  commissionCents: number;
  commissionBpsApplied: number;
  /** VAT on the operator's service fee, not on the driver's transport service. */
  vatOnCommissionCents: number;
  /** What the driver keeps. */
  driverEarningsCents: number;

  /** Human-readable lines for the receipt, in the rider's language. */
  explain: Array<{ key: string; amountCents: number }>;
}

/** 10 000 basis points = 100%. */
const BPS_DIVISOR = 10_000;
/** Tanzanian standard-rate VAT. Verify against the Finance Act in force. */
const VAT_BPS = 1_800; // 18%
/** Customer-facing rounding step, in cents (50 TZS). */
const ROUNDING_STEP_CENTS = 5_000;

@Injectable()
export class FareService {
  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // =====================================================================
  // Public API
  // =====================================================================

  /**
   * Produces a quote and caches it under a quote id. The rider requests a
   * ride by quote id, so the price they saw is the price that binds — a
   * surge spike between tapping and confirming cannot raise it.
   */
  async quote(input: FareInput): Promise<{ quoteId: string; fare: FareBreakdown; expiresAt: Date }> {
    const surge = await this.currentSurge(input.pickup, input.category);
    const fare = await this.calculate({ ...input, lockedSurge: surge });

    const quoteId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const ttlSeconds = 180;

    await this.redis.set(
      `quote:${quoteId}`,
      JSON.stringify({ input, fare }),
      'EX',
      ttlSeconds,
    );

    return {
      quoteId,
      fare,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  /**
   * Core calculation. Pure apart from the tariff lookup, so it is directly
   * unit-testable against gazetted fare examples.
   */
  async calculate(input: FareInput): Promise<FareBreakdown> {
    if (input.distanceMetres < 0 || input.durationSeconds < 0) {
      throw new BadRequestException('distance and duration must be non-negative');
    }

    const zoneId = await this.resolveZone(input.pickup);
    const tariff = await this.loadTariff(input.category, zoneId);

    // ---- Metered components -----------------------------------------
    const km = input.distanceMetres / 1000;
    const minutes = input.durationSeconds / 60;

    const distanceChargeCents = Math.round(km * tariff.perKmCents);
    const timeChargeCents = Math.round(minutes * tariff.perMinuteCents);

    // Waiting is only chargeable past the free grace window.
    const billableWaitSeconds = Math.max(
      0,
      (input.waitingSeconds ?? 0) - tariff.freeWaitingSeconds,
    );
    const waitingChargeCents = Math.round(
      (billableWaitSeconds / 60) * tariff.waitingPerMinuteCents,
    );

    const zoneSurchargeCents = input.zoneSurchargeCents ?? 0;

    const subtotalCents =
      tariff.baseFareCents +
      distanceChargeCents +
      timeChargeCents +
      waitingChargeCents +
      zoneSurchargeCents;

    // ---- Surge --------------------------------------------------------
    // Capped by the tariff row, so the regulator's ceiling holds even if the
    // demand model asks for more.
    const rawSurge = input.lockedSurge ?? 1.0;
    const surgeMultiplier = Math.min(Math.max(1.0, rawSurge), tariff.maxSurgeMultiplier);
    const surgedCents = Math.round(subtotalCents * surgeMultiplier);
    const surgeAmountCents = surgedCents - subtotalCents;

    // ---- Minimum fare -------------------------------------------------
    // A 400 m boda hop still has to clear the gazetted floor.
    const afterMinimum = Math.max(surgedCents, tariff.minimumFareCents);
    const minimumFareAppliedCents = afterMinimum - surgedCents;

    // ---- Promotions ---------------------------------------------------
    // Discounts come out of the operator's margin, never the driver's: the
    // driver is paid on the pre-discount fare.
    const promoDiscountCents = Math.min(input.promoDiscountCents ?? 0, afterMinimum);
    const fareBeforeBooking = afterMinimum;

    // ---- Booking fee --------------------------------------------------
    const bookingFeeCents = Math.round(
      (fareBeforeBooking * tariff.bookingFeeBpsCap) / BPS_DIVISOR,
    );

    const totalFareCents = this.roundToStep(
      fareBeforeBooking + bookingFeeCents - promoDiscountCents,
    );

    // ---- Commission split ---------------------------------------------
    // Commission is charged on the transport fare only, excluding the
    // booking fee and any zone surcharge that is passed through.
    const commissionableCents = fareBeforeBooking - zoneSurchargeCents;
    const commissionCents = Math.round(
      (commissionableCents * tariff.commissionBpsCap) / BPS_DIVISOR,
    );
    const vatOnCommissionCents = Math.round((commissionCents * VAT_BPS) / BPS_DIVISOR);

    // The driver keeps the fare minus commission, plus any surcharge that
    // belongs to them, and is not penalised for the platform's promo.
    const driverEarningsCents =
      fareBeforeBooking - commissionCents + 0 - 0;

    return {
      tariffId: tariff.id,
      gazetteReference: tariff.gazetteReference,
      currency: 'TZS',
      baseFareCents: tariff.baseFareCents,
      distanceChargeCents,
      timeChargeCents,
      waitingChargeCents,
      zoneSurchargeCents,
      subtotalCents,
      surgeMultiplier,
      surgeAmountCents,
      minimumFareAppliedCents,
      promoDiscountCents,
      bookingFeeCents,
      totalFareCents,
      commissionCents,
      commissionBpsApplied: tariff.commissionBpsCap,
      vatOnCommissionCents,
      driverEarningsCents,
      explain: [
        { key: 'fare.base', amountCents: tariff.baseFareCents },
        { key: 'fare.distance', amountCents: distanceChargeCents },
        { key: 'fare.time', amountCents: timeChargeCents },
        ...(waitingChargeCents ? [{ key: 'fare.waiting', amountCents: waitingChargeCents }] : []),
        ...(zoneSurchargeCents ? [{ key: 'fare.zone', amountCents: zoneSurchargeCents }] : []),
        ...(surgeAmountCents ? [{ key: 'fare.surge', amountCents: surgeAmountCents }] : []),
        ...(minimumFareAppliedCents
          ? [{ key: 'fare.minimum_adjustment', amountCents: minimumFareAppliedCents }]
          : []),
        ...(bookingFeeCents ? [{ key: 'fare.booking', amountCents: bookingFeeCents }] : []),
        ...(promoDiscountCents ? [{ key: 'fare.promo', amountCents: -promoDiscountCents }] : []),
        { key: 'fare.total', amountCents: totalFareCents },
      ],
    };
  }

  /**
   * Settlement fare. Uses the actual driven distance and duration, but is
   * bounded above by the quote plus a tolerance — if the driver took a longer
   * route than quoted, the rider does not silently absorb it. Anything past
   * the tolerance goes to a review queue instead of the rider's bill.
   */
  async settle(
    input: FareInput,
    quotedTotalCents: number,
    toleranceBps = 2_000, // 20%
  ): Promise<{ fare: FareBreakdown; cappedByQuote: boolean; needsReview: boolean }> {
    const fare = await this.calculate({ ...input, isSettlement: true });
    const ceiling = quotedTotalCents + Math.round((quotedTotalCents * toleranceBps) / BPS_DIVISOR);

    if (fare.totalFareCents > ceiling) {
      const capped = { ...fare, totalFareCents: ceiling };
      return { fare: capped, cappedByQuote: true, needsReview: true };
    }
    return { fare, cappedByQuote: false, needsReview: false };
  }

  /** Cancellation fee, chargeable only after the driver has committed time. */
  async cancellationFee(
    category: VehicleCategory,
    pickup: { lat: number; lng: number },
    secondsSinceAccept: number,
    driverHasArrived: boolean,
  ): Promise<number> {
    // Free cancellation window: nobody should pay for changing their mind in
    // the first two minutes, and a no-show driver is never chargeable.
    if (secondsSinceAccept < 120 && !driverHasArrived) return 0;
    const tariff = await this.loadTariff(category, await this.resolveZone(pickup));
    return tariff.cancellationFeeCents;
  }

  // =====================================================================
  // Surge
  // =====================================================================

  /**
   * Demand/supply surge for the geohash tile containing the pickup.
   *
   * The curve is deliberately gentle and stepped rather than continuous:
   *  * a smooth multiplier makes the displayed price flicker between taps;
   *  * LATRA's framework treats fares as regulated, so a wide, fast-moving
   *    multiplier is both a commercial and a compliance risk.
   *
   * Tiles are refreshed every 60 s by a worker that writes:
   *    surge:{tile}:{category} -> "requests:drivers"
   */
  async currentSurge(
    point: { lat: number; lng: number },
    category: VehicleCategory,
  ): Promise<number> {
    const tile = geohash(point.lat, point.lng, 6); // ~1.2 km × 0.6 km
    const raw = await this.redis.get(`surge:${tile}:${category}`);
    if (!raw) return 1.0;

    const [requestsStr, driversStr] = raw.split(':');
    const openRequests = Number.parseInt(requestsStr, 10) || 0;
    const idleDrivers = Number.parseInt(driversStr, 10) || 0;

    // Too little activity to infer anything; a single request in a quiet
    // tile must not produce a 2× multiplier.
    if (openRequests < 3) return 1.0;
    if (idleDrivers === 0) return 1.6;

    const ratio = openRequests / idleDrivers;
    if (ratio <= 1.0) return 1.0;
    if (ratio <= 1.5) return 1.1;
    if (ratio <= 2.0) return 1.2;
    if (ratio <= 3.0) return 1.4;
    return 1.6;
  }

  /**
   * Recomputes surge for every active tile. Run on a 60-second schedule.
   * Persists to `surge_tiles` for analytics and to Redis for the hot path.
   */
  async refreshSurgeTiles(): Promise<void> {
    const rows = await this.db.query(`
      WITH demand AS (
        SELECT ST_GeoHash(pickup_point::geometry, 6) AS tile,
               requested_category AS category,
               COUNT(*)           AS open_requests,
               ST_Centroid(ST_Collect(pickup_point::geometry))::geography AS centroid
          FROM rides
         WHERE status IN ('requested', 'searching')
           AND requested_at > now() - interval '10 minutes'
         GROUP BY 1, 2
      ),
      supply AS (
        SELECT ST_GeoHash(d.last_location::geometry, 6) AS tile,
               v.category,
               COUNT(*) AS idle_drivers
          FROM drivers d
          JOIN vehicles v ON v.id = d.active_vehicle_id
         WHERE d.state = 'online_idle'
           AND d.last_location_at > now() - interval '45 seconds'
         GROUP BY 1, 2
      )
      SELECT d.tile, d.category, d.open_requests,
             COALESCE(s.idle_drivers, 0) AS idle_drivers, d.centroid
        FROM demand d
        LEFT JOIN supply s ON s.tile = d.tile AND s.category = d.category
    `);

    const pipeline = this.redis.pipeline();
    for (const row of rows) {
      pipeline.set(
        `surge:${row.tile}:${row.category}`,
        `${row.open_requests}:${row.idle_drivers}`,
        'EX',
        120,
      );
    }
    await pipeline.exec();

    if (rows.length > 0) {
      const values = rows
        .map(
          (_: unknown, i: number) =>
            `($${i * 5 + 1}, $${i * 5 + 2}, date_trunc('minute', now()), $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`,
        )
        .join(', ');
      const params = rows.flatMap((r: any) => {
        const ratio = r.idle_drivers > 0 ? r.open_requests / r.idle_drivers : 99;
        const multiplier =
          r.open_requests < 3 ? 1.0 : ratio <= 1 ? 1.0 : ratio <= 1.5 ? 1.1 : ratio <= 2 ? 1.2 : ratio <= 3 ? 1.4 : 1.6;
        return [r.tile, r.category, r.open_requests, r.idle_drivers, multiplier];
      });
      await this.db.query(
        `INSERT INTO surge_tiles (tile_id, category, window_start, open_requests, idle_drivers, multiplier)
         VALUES ${values}
         ON CONFLICT (tile_id, category, window_start) DO UPDATE
           SET open_requests = EXCLUDED.open_requests,
               idle_drivers  = EXCLUDED.idle_drivers,
               multiplier    = EXCLUDED.multiplier`,
        params,
      );
    }
  }

  // =====================================================================
  // Tariff resolution
  // =====================================================================

  /**
   * Zone-specific tariff wins over the national one. Cached for 5 minutes;
   * a gazette change is not a per-second event, but the cache is short enough
   * that ops can push a new rate card without a restart.
   */
  private async loadTariff(category: VehicleCategory, zoneId: string | null): Promise<Tariff> {
    const cacheKey = `tariff:${category}:${zoneId ?? 'national'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [row] = await this.db.query(
      `SELECT * FROM tariffs
        WHERE category = $1
          AND (zone_id = $2 OR zone_id IS NULL)
          AND valid_from <= now()
          AND (valid_to IS NULL OR valid_to > now())
        ORDER BY zone_id NULLS LAST, valid_from DESC
        LIMIT 1`,
      [category, zoneId],
    );

    if (!row) throw new BadRequestException(`no active tariff for ${category}`);

    const tariff: Tariff = {
      id: row.id,
      category: row.category,
      baseFareCents: Number(row.base_fare_cents),
      perKmCents: Number(row.per_km_cents),
      perMinuteCents: Number(row.per_minute_cents),
      minimumFareCents: Number(row.minimum_fare_cents),
      waitingPerMinuteCents: Number(row.waiting_per_minute_cents),
      freeWaitingSeconds: Number(row.free_waiting_seconds),
      cancellationFeeCents: Number(row.cancellation_fee_cents),
      commissionBpsCap: Number(row.commission_bps_cap),
      bookingFeeBpsCap: Number(row.booking_fee_bps_cap),
      maxSurgeMultiplier: Number(row.max_surge_multiplier),
      gazetteReference: row.gazette_reference,
    };

    await this.redis.set(cacheKey, JSON.stringify(tariff), 'EX', 300);
    return tariff;
  }

  private async resolveZone(point: { lat: number; lng: number }): Promise<string | null> {
    const [row] = await this.db.query(
      `SELECT zone_for_point(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS zone_id`,
      [point.lng, point.lat],
    );
    return row?.zone_id ?? null;
  }

  /** Rounds to the nearest 50 TZS so drivers can actually make change. */
  private roundToStep(cents: number): number {
    return Math.round(cents / ROUNDING_STEP_CENTS) * ROUNDING_STEP_CENTS;
  }
}

// ---------------------------------------------------------------------
// Minimal geohash encoder (no dependency; matches PostGIS ST_GeoHash).
// ---------------------------------------------------------------------
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohash(lat: number, lng: number, precision = 6): string {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngMin = mid; } else { ch <<= 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}
