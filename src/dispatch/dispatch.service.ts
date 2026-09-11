/**
 * DispatchService — driver matching for Kwema Ride.
 *
 * Strategy
 *  1. Candidate retrieval from Redis GEOSEARCH (sub-millisecond, per
 *     vehicle category so a bajaji request never scans boda drivers).
 *  2. Enrichment + hard filtering from a Redis hash of driver state, with a
 *     single Postgres round trip only for the survivors.
 *  3. Multi-factor scoring, then *sequential* offering with a distributed
 *     lock so two rides can never be offered to the same driver at once.
 *  4. PostGIS fallback if the geo set is empty (cold start, Redis failover).
 *
 * Radius expansion: we start tight and widen in rings. In Dar es Salaam a
 * 1.5 km first ring is dense enough at peak; in Dodoma or a Mwanza suburb
 * the third ring does the work. Widening is cheaper than a bad first match.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { REDIS } from '../common/redis.module';

export type VehicleCategory =
  | 'boda' | 'bajaji' | 'standard' | 'xl' | 'express'
  // Electric equivalents. Separate tiers because they carry their own rate
  // cards; a bajaji is a tuk-tuk, so there is no separate tuk-tuk tier.
  | 'e_boda' | 'e_bajaji' | 'e_car';

export interface DispatchRequest {
  rideId: string;
  riderId: string;
  category: VehicleCategory;
  pickup: { lat: number; lng: number };
  /** Rider-set preferences that act as hard filters. */
  requireHelmet?: boolean;
  minDriverRating?: number;
  /** Drivers the rider has blocked, or who already declined this ride. */
  excludeDriverIds?: string[];
}

export interface ScoredDriver {
  driverId: string;
  vehicleId: string;
  distanceM: number;
  etaSeconds: number;
  score: number;
  acceptanceRate: number;
  rating: number;
}

/** Cached per-driver state, written by the realtime gateway on each ping. */
interface DriverSnapshot {
  driverId: string;
  vehicleId: string;
  category: VehicleCategory;
  state: string;
  rating: number;
  acceptanceRate: number;
  cancellationRate: number;
  completedTrips: number;
  walletBalanceCents: number;
  helmets: number;
  lastPingAt: number; // epoch ms
  /** Unix epoch (seconds) of the earliest expiring statutory document. */
  complianceValidUntil: number;
}

// --- Tunables. Every one of these is a business lever; keep them in config
// --- rather than inline so ops can retune per city without a redeploy.
export const DISPATCH_CONFIG = {
  /** Expanding search rings, in metres. */
  radiusRingsM: {
    boda: [1000, 2500, 4000],
    bajaji: [1200, 3000, 5000],
    standard: [1500, 3500, 7000],
    xl: [2500, 5000, 9000],
    express: [1500, 3500, 7000],
    // Wider rings for electric: the fleet is far smaller, so a tight first
    // ring would report "no drivers" while one sat two kilometres away.
    e_boda: [2000, 4000, 6000],
    e_bajaji: [2500, 4500, 7000],
    e_car: [3000, 6000, 9000],
  } as Record<VehicleCategory, number[]>,

  /** How many candidates to score per ring. */
  candidatePoolSize: 25,
  /** How many drivers we actually offer to, in order. */
  offerDepth: 5,
  /** Seconds a driver has to answer before we move to the next. */
  offerTtlSeconds: 15,
  /** A ping older than this means the device dropped off; skip the driver. */
  maxPingAgeMs: 45_000,
  /** Drivers who owe more than this in cash commission stop receiving offers. */
  walletFloorCents: -1_000_000, // -10,000 TZS

  /** Scoring weights — must sum to 1.0. */
  weights: {
    proximity: 0.50,
    acceptance: 0.20,
    rating: 0.15,
    idleTime: 0.10,
    completion: 0.05,
  },

  /**
   * Average urban speeds used for ETA when the routing API is unreachable.
   * Boda weave through Dar traffic; a saloon car does not.
   */
  fallbackSpeedKph: {
    boda: 22,
    bajaji: 16,
    standard: 14,
    xl: 13,
    express: 14,
    // Same road conditions; the motor makes no difference to traffic.
    e_boda: 22,
    e_bajaji: 16,
    e_car: 14,
  } as Record<VehicleCategory, number>,
};

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly db: DataSource,
  ) {}

  // =====================================================================
  // Public API
  // =====================================================================

  /**
   * Returns the ordered shortlist of drivers to offer a ride to.
   * Does not send the offers — see `offerSequentially`.
   */
  async findCandidates(req: DispatchRequest): Promise<ScoredDriver[]> {
    const rings = DISPATCH_CONFIG.radiusRingsM[req.category];
    const excluded = new Set(req.excludeDriverIds ?? []);

    for (const radiusM of rings) {
      const raw = await this.geoSearch(req.category, req.pickup, radiusM);
      if (raw.length === 0) continue;

      const snapshots = await this.hydrate(raw.map((r) => r.driverId));
      const eligible: ScoredDriver[] = [];

      for (const hit of raw) {
        const snap = snapshots.get(hit.driverId);
        if (!snap) continue;
        if (excluded.has(hit.driverId)) continue;
        if (!this.passesHardFilters(snap, req)) continue;

        const etaSeconds = this.estimateEta(hit.distanceM, req.category);
        eligible.push({
          driverId: snap.driverId,
          vehicleId: snap.vehicleId,
          distanceM: hit.distanceM,
          etaSeconds,
          acceptanceRate: snap.acceptanceRate,
          rating: snap.rating,
          score: this.score(snap, hit.distanceM, radiusM),
        });
      }

      if (eligible.length > 0) {
        eligible.sort((a, b) => b.score - a.score);
        const shortlist = eligible.slice(0, DISPATCH_CONFIG.offerDepth);
        this.logger.log(
          `ride=${req.rideId} matched ${shortlist.length}/${raw.length} ` +
            `${req.category} drivers within ${radiusM}m`,
        );
        return shortlist;
      }
    }

    // Redis returned nothing across every ring. Either genuinely no supply,
    // or the geo set is cold after a failover — verify against PostGIS
    // before telling the rider there are no drivers.
    this.logger.warn(`ride=${req.rideId} no Redis candidates, falling back to PostGIS`);
    return this.findCandidatesViaPostgis(req);
  }

  /**
   * Offers the ride to each candidate in turn until one accepts.
   * Returns the winning driver id, or null if the shortlist is exhausted.
   *
   * `notify` is injected rather than called directly so this stays testable
   * and so the realtime gateway owns socket concerns.
   */
  async offerSequentially(
    req: DispatchRequest,
    candidates: ScoredDriver[],
    notify: (driverId: string, offer: ScoredDriver, ttlSeconds: number) => Promise<void>,
    waitForResponse: (rideId: string, driverId: string, ttlSeconds: number) => Promise<'accepted' | 'declined' | 'timeout'>,
  ): Promise<string | null> {
    const ttl = DISPATCH_CONFIG.offerTtlSeconds;

    for (const [index, candidate] of candidates.entries()) {
      // Reserve the driver. NX guarantees a driver being offered ride A
      // cannot simultaneously be offered ride B — the classic double-offer
      // bug that makes drivers accept a ride that is already gone.
      const lockKey = `dispatch:lock:driver:${candidate.driverId}`;
      const locked = await this.redis.set(lockKey, req.rideId, 'EX', ttl + 2, 'NX');
      if (locked !== 'OK') continue;

      try {
        await this.recordOffer(req.rideId, candidate, index + 1, ttl);
        await notify(candidate.driverId, candidate, ttl);

        const outcome = await waitForResponse(req.rideId, candidate.driverId, ttl);
        await this.closeOffer(req.rideId, candidate.driverId, outcome);
        await this.updateAcceptanceCounters(candidate.driverId, outcome);

        if (outcome === 'accepted') return candidate.driverId;
      } finally {
        // Release only if we still own the lock (Lua compare-and-delete).
        await this.releaseLock(lockKey, req.rideId);
      }
    }

    return null;
  }

  /**
   * Writes a driver's position into the geo set. Called from the realtime
   * gateway on every location ping. One sorted set per category keeps
   * GEOSEARCH scans small and lets us shard by category later.
   */
  async upsertDriverPosition(
    driverId: string,
    category: VehicleCategory,
    lat: number,
    lng: number,
  ): Promise<void> {
    await this.redis
      .multi()
      .geoadd(this.geoKey(category), lng, lat, driverId)
      .hset(`driver:${driverId}`, 'lastPingAt', Date.now().toString())
      .expire(`driver:${driverId}`, 3600)
      .exec();
  }

  async removeDriverFromPool(driverId: string, category: VehicleCategory): Promise<void> {
    await this.redis.zrem(this.geoKey(category), driverId);
  }

  // =====================================================================
  // Candidate retrieval
  // =====================================================================

  private geoKey(category: VehicleCategory): string {
    return `geo:drivers:${category}`;
  }

  private async geoSearch(
    category: VehicleCategory,
    pickup: { lat: number; lng: number },
    radiusM: number,
  ): Promise<Array<{ driverId: string; distanceM: number }>> {
    // GEOSEARCH ... BYRADIUS ... M ASC WITHDIST COUNT n
    // COUNT with ASC lets Redis stop early instead of sorting the whole set.
    const results = (await this.redis.call(
      'GEOSEARCH',
      this.geoKey(category),
      'FROMLONLAT',
      pickup.lng.toString(),
      pickup.lat.toString(),
      'BYRADIUS',
      radiusM.toString(),
      'm',
      'ASC',
      'COUNT',
      DISPATCH_CONFIG.candidatePoolSize.toString(),
      'WITHDIST',
    )) as Array<[string, string]>;

    return results.map(([driverId, dist]) => ({
      driverId,
      distanceM: Number.parseFloat(dist),
    }));
  }

  /** Batch-loads driver snapshots with one pipeline instead of N round trips. */
  private async hydrate(driverIds: string[]): Promise<Map<string, DriverSnapshot>> {
    if (driverIds.length === 0) return new Map();

    const pipeline = this.redis.pipeline();
    for (const id of driverIds) pipeline.hgetall(`driver:${id}`);
    const replies = await pipeline.exec();

    const out = new Map<string, DriverSnapshot>();
    replies?.forEach(([err, value], i) => {
      const hash = value as Record<string, string> | null;
      if (err || !hash || Object.keys(hash).length === 0) return;
      out.set(driverIds[i], {
        driverId: driverIds[i],
        vehicleId: hash.vehicleId,
        category: hash.category as VehicleCategory,
        state: hash.state,
        rating: Number.parseFloat(hash.rating ?? '5'),
        acceptanceRate: Number.parseFloat(hash.acceptanceRate ?? '1'),
        cancellationRate: Number.parseFloat(hash.cancellationRate ?? '0'),
        completedTrips: Number.parseInt(hash.completedTrips ?? '0', 10),
        walletBalanceCents: Number.parseInt(hash.walletBalanceCents ?? '0', 10),
        helmets: Number.parseInt(hash.helmets ?? '0', 10),
        lastPingAt: Number.parseInt(hash.lastPingAt ?? '0', 10),
        complianceValidUntil: Number.parseInt(hash.complianceValidUntil ?? '0', 10),
      });
    });
    return out;
  }

  /**
   * Hard filters — a driver failing any of these is never offered the ride,
   * regardless of how close they are.
   */
  private passesHardFilters(snap: DriverSnapshot, req: DispatchRequest): boolean {
    if (snap.state !== 'online_idle') return false;
    if (Date.now() - snap.lastPingAt > DISPATCH_CONFIG.maxPingAgeMs) return false;
    if (snap.walletBalanceCents < DISPATCH_CONFIG.walletFloorCents) return false;
    // Licence/insurance must be valid *now*, not when the driver signed on.
    if (snap.complianceValidUntil * 1000 < Date.now()) return false;
    if (req.minDriverRating && snap.rating < req.minDriverRating) return false;
    if (req.requireHelmet && snap.category === 'boda' && snap.helmets < 2) return false;
    return true;
  }

  // =====================================================================
  // Scoring
  // =====================================================================

  /**
   * Composite score in [0, 1]. Proximity dominates because a rider standing
   * on Samora Avenue cares far more about a 2-minute wait than about a 4.9
   * vs 4.7 driver rating — but the other terms break ties and stop the same
   * three drivers near a mall from absorbing every trip.
   */
  private score(snap: DriverSnapshot, distanceM: number, radiusM: number): number {
    const w = DISPATCH_CONFIG.weights;

    // Linear decay to the ring edge. Squaring would over-punish the 800 m
    // driver relative to the 400 m one for little real-world gain.
    const proximity = Math.max(0, 1 - distanceM / radiusM);

    const acceptance = clamp01(snap.acceptanceRate);

    // Map 1..5 stars onto 0..1, then penalise cancellations directly.
    const rating = clamp01((snap.rating - 1) / 4) * (1 - clamp01(snap.cancellationRate));

    // Fairness term: the longer a driver has waited without an offer, the
    // higher this climbs. Caps at 20 minutes so it never outweighs distance.
    const idleMinutes = (Date.now() - snap.lastPingAt) / 60_000;
    const idleTime = clamp01(idleMinutes / 20);

    // Experience, with diminishing returns after ~500 trips.
    const completion = clamp01(Math.log10(snap.completedTrips + 1) / Math.log10(501));

    return (
      w.proximity * proximity +
      w.acceptance * acceptance +
      w.rating * rating +
      w.idleTime * idleTime +
      w.completion * completion
    );
  }

  /**
   * ETA without a routing round trip. Real dispatch calls the Distance
   * Matrix for the top 3 only — a matrix call per candidate would blow both
   * the latency budget and the maps bill.
   *
   * The 1.35 factor converts straight-line to road distance; it is tuned per
   * city from completed-trip telemetry (Dar's peninsular road layout makes
   * it higher than Dodoma's grid).
   */
  private estimateEta(distanceM: number, category: VehicleCategory): number {
    const roadDistanceM = distanceM * 1.35;
    const speedMps = (DISPATCH_CONFIG.fallbackSpeedKph[category] * 1000) / 3600;
    return Math.round(roadDistanceM / speedMps);
  }

  // =====================================================================
  // PostGIS fallback
  // =====================================================================

  private async findCandidatesViaPostgis(req: DispatchRequest): Promise<ScoredDriver[]> {
    const rings = DISPATCH_CONFIG.radiusRingsM[req.category];
    const maxRadius = rings[rings.length - 1];

    const rows = await this.db.query(
      `SELECT driver_id, vehicle_id, distance_m, acceptance_rate, rating_avg
         FROM find_nearby_drivers(
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           $3, $4::vehicle_category, $5)`,
      [req.pickup.lng, req.pickup.lat, maxRadius, req.category, DISPATCH_CONFIG.candidatePoolSize],
    );

    const excluded = new Set(req.excludeDriverIds ?? []);
    return rows
      .filter((r: any) => !excluded.has(r.driver_id))
      .map((r: any): ScoredDriver => {
        const distanceM = Number(r.distance_m);
        return {
          driverId: r.driver_id,
          vehicleId: r.vehicle_id,
          distanceM,
          etaSeconds: this.estimateEta(distanceM, req.category),
          acceptanceRate: Number(r.acceptance_rate),
          rating: Number(r.rating_avg),
          // Degraded scoring: only the fields Postgres gave us.
          score:
            0.7 * Math.max(0, 1 - distanceM / maxRadius) +
            0.3 * clamp01(Number(r.acceptance_rate)),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, DISPATCH_CONFIG.offerDepth);
  }

  // =====================================================================
  // Offer bookkeeping
  // =====================================================================

  private async recordOffer(
    rideId: string,
    candidate: ScoredDriver,
    rank: number,
    ttlSeconds: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ride_offers
         (ride_id, driver_id, rank, score, distance_m, eta_seconds, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)
       ON CONFLICT (ride_id, driver_id) DO NOTHING`,
      [
        rideId,
        candidate.driverId,
        rank,
        candidate.score.toFixed(4),
        Math.round(candidate.distanceM),
        candidate.etaSeconds,
        ttlSeconds,
      ],
    );
  }

  private async closeOffer(rideId: string, driverId: string, outcome: string): Promise<void> {
    await this.db.query(
      `UPDATE ride_offers
          SET responded_at = now(), outcome = $3
        WHERE ride_id = $1 AND driver_id = $2 AND outcome IS NULL`,
      [rideId, driverId, outcome],
    );
  }

  /**
   * Rolling 24h acceptance rate. Kept in Redis for the dispatch hot path and
   * flushed to Postgres by a periodic job; recomputing from ride_offers on
   * every dispatch would not survive peak load.
   */
  private async updateAcceptanceCounters(driverId: string, outcome: string): Promise<void> {
    const key = `driver:${driverId}`;
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, 'offersSent24h', 1);
    if (outcome === 'accepted') pipeline.hincrby(key, 'offersAccepted24h', 1);
    const [[, sent], [, accepted]] = (await pipeline.exec()) as Array<[unknown, number]>;

    const rate = sent > 0 ? Math.min(1, (accepted ?? 0) / sent) : 1;
    await this.redis.hset(key, 'acceptanceRate', rate.toFixed(3));
  }

  /** Compare-and-delete so we never release a lock another dispatch re-took. */
  private async releaseLock(key: string, expectedValue: string): Promise<void> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end`;
    await this.redis.eval(script, 1, key, expectedValue);
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
