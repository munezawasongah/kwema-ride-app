/**
 * RidesService — the ride lifecycle and the orchestration around dispatch.
 *
 * Two things here are load-bearing and worth reading before changing:
 *
 *  1. `claim` is the only place a ride gets a driver, and it does so with a
 *     conditional UPDATE (`WHERE driver_id IS NULL`). Two drivers tapping
 *     accept in the same millisecond both reach this statement; exactly one
 *     row is updated and the other gets zero. No lock, no race.
 *
 *  2. Fares are always computed server-side from the breadcrumb trail, never
 *     from a distance the driver app reports. A device that reports its own
 *     mileage is a device that can be modified to report more.
 */

import { Injectable, Inject, Logger, BadRequestException, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import * as crypto from 'node:crypto';

import { REDIS } from '../common/redis.module';
import { DispatchService, ScoredDriver, VehicleCategory } from '../dispatch/dispatch.service';
import { FareService } from '../pricing/fare.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface BreadcrumbInput {
  driverId: string;
  rideId: string | null;
  lat: number;
  lng: number;
  headingDeg: number | null;
  speedKph: number | null;
  accuracyM: number | null;
  recordedAt: Date;
  isBackfilled: boolean;
}

const OFFER_TTL_SECONDS = 15;

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  /** Buffered breadcrumbs, flushed in batches. See `flushBreadcrumbs`. */
  private breadcrumbBuffer: BreadcrumbInput[] = [];

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly dispatch: DispatchService,
    private readonly fares: FareService,
    @Inject(forwardRef(() => RealtimeGateway))
    private readonly gateway: RealtimeGateway,
  ) {}

  // ===================================================================
  // Creation
  // ===================================================================

  /**
   * Idempotent on (rider, clientGeneratedId). A retry after a dropped ack on
   * a 3G connection returns the existing ride instead of creating a second.
   */
  async createOrGet(riderId: string, body: any) {
    const [existing] = await this.db.query(
      `SELECT * FROM rides WHERE rider_id = $1 AND client_generated_id = $2`,
      [riderId, body.clientGeneratedId],
    );
    if (existing) return existing;

    // The quote is authoritative for price. An expired quote is refused
    // rather than silently re-priced at whatever surge is current.
    const cached = await this.redis.get(`quote:${body.quoteId}`);
    if (!cached) throw new BadRequestException('quote_expired');
    const { fare } = JSON.parse(cached);

    const reference = this.generateReference();

    const [ride] = await this.db.query(
      `INSERT INTO rides (
          reference, client_generated_id, rider_id, requested_category, status,
          pickup_point, pickup_address, dropoff_point, dropoff_address,
          pickup_zone_id, tariff_id, quoted_fare_cents, quoted_distance_m,
          quoted_duration_s, surge_multiplier, payment_method)
       VALUES (
          $1, $2, $3, $4::vehicle_category, 'requested',
          ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7,
          ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, $10,
          zone_for_point(ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography),
          $11, $12, $13, $14, $15, $16::payment_method)
       RETURNING *`,
      [
        reference,
        body.clientGeneratedId,
        riderId,
        body.category,
        body.pickup.lng,
        body.pickup.lat,
        body.pickup.address ?? null,
        body.dropoff.lng,
        body.dropoff.lat,
        body.dropoff.address ?? null,
        fare.tariffId,
        fare.totalFareCents,
        body.distanceMetres ?? null,
        body.durationSeconds ?? null,
        fare.surgeMultiplier,
        body.paymentMethod,
      ],
    );

    return ride;
  }

  // ===================================================================
  // Dispatch orchestration
  // ===================================================================

  /**
   * Runs the offer loop. Called fire-and-forget from the gateway; progress
   * reaches the rider over `ride:status_change`, never over the HTTP reply.
   */
  async startDispatch(rideId: string): Promise<void> {
    const [ride] = await this.db.query(
      `SELECT id, rider_id, requested_category,
              ST_Y(pickup_point::geometry) AS lat,
              ST_X(pickup_point::geometry) AS lng,
              quoted_fare_cents, payment_method, status
         FROM rides WHERE id = $1`,
      [rideId],
    );
    if (!ride || ride.status !== 'requested') return;

    // Subscribe the rider's live sockets to this ride's room.
    //
    // The WebSocket request path joins the room itself, but a ride created
    // over HTTP — which the web client and the mobile fallback both use —
    // never did. Every status update was then emitted to a room the rider was
    // not in, so the app sat on "requesting" forever while dispatch ran
    // normally in the background. socketsJoin reaches sockets on any node via
    // the Redis adapter, so this works with more than one replica.
    try {
      await this.gateway.server
        .in(`user:${ride.rider_id}`)
        .socketsJoin(`ride:${rideId}`);
    } catch (err) {
      this.logger.warn(
        `could not join rider to ride room ${rideId}: ${(err as Error).message}`,
      );
    }

    await this.db.query(`UPDATE rides SET status = 'searching' WHERE id = $1`, [rideId]);
    this.gateway.server.to(`ride:${rideId}`).emit('ride:status_change', {
      rideId,
      status: 'searching',
    });

    const declined: string[] = [];

    // Three passes. Between passes drivers move and new ones come online, so
    // a rider on a quiet street gets a second and third chance rather than an
    // immediate "no drivers".
    for (let pass = 0; pass < 3; pass++) {
      const candidates = await this.dispatch.findCandidates({
        rideId,
        riderId: ride.rider_id,
        category: ride.requested_category as VehicleCategory,
        pickup: { lat: Number(ride.lat), lng: Number(ride.lng) },
        excludeDriverIds: declined,
      });

      if (candidates.length === 0) {
        await this.sleep(4000);
        continue;
      }

      const winner = await this.dispatch.offerSequentially(
        {
          rideId,
          riderId: ride.rider_id,
          category: ride.requested_category as VehicleCategory,
          pickup: { lat: Number(ride.lat), lng: Number(ride.lng) },
          excludeDriverIds: declined,
        },
        candidates,
        (driverId, offer, ttl) => this.sendOffer(rideId, ride, driverId, offer, ttl),
        (rid, driverId, ttl) => this.awaitResponse(rid, driverId, ttl),
      );

      if (winner) return;
      declined.push(...candidates.map((c) => c.driverId));
    }

    // Exhausted. Expire rather than leaving the ride open forever, and tell
    // the rider plainly so they can re-request or switch category.
    await this.db.query(
      `UPDATE rides SET status = 'expired', cancelled_at = now(),
              cancellation_reason = 'no_drivers_available'
        WHERE id = $1 AND status = 'searching'`,
      [rideId],
    );
    this.gateway.server.to(`ride:${rideId}`).emit('ride:status_change', {
      rideId,
      status: 'expired',
      reasonCode: 'no_drivers_available',
    });
  }

  /**
   * Pushes an offer to one driver's personal room, with a signed token the
   * driver must return on accept. The token is what stops a driver from
   * claiming a ride id they were never offered.
   */
  private async sendOffer(
    rideId: string,
    ride: any,
    driverId: string,
    offer: ScoredDriver,
    ttlSeconds: number,
  ): Promise<void> {
    const token = this.signOfferToken(rideId, driverId);
    await this.redis.set(`offer:${rideId}:${driverId}`, token, 'EX', ttlSeconds + 5);

    const [detail] = await this.db.query(
      `SELECT r.pickup_address, r.dropoff_address, r.quoted_fare_cents,
              r.quoted_distance_m, r.surge_multiplier, r.payment_method,
              u.rating_avg AS rider_rating,
              t.commission_bps_cap
         FROM rides r
         JOIN users u ON u.id = r.rider_id
         LEFT JOIN tariffs t ON t.id = r.tariff_id
        WHERE r.id = $1`,
      [rideId],
    );

    const fare = Number(detail.quoted_fare_cents);
    // Fallback only — the live tariff is the source of truth. Kept in step
    // with the operator's standard rate so a missing tariff cannot quietly
    // show a driver a higher take-home than they will actually receive.
    const commissionBps = Number(detail.commission_bps_cap ?? 1500);

    this.gateway.server.to(`driver:${driverId}`).emit('ride:request', {
      rideId,
      offerToken: token,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      ttlSeconds,
      pickupAddress: detail.pickup_address ?? 'Mahali pa kuchukua',
      dropoffAddress: detail.dropoff_address ?? 'Mahali pa kushusha',
      distanceToPickupM: Math.round(offer.distanceM),
      etaToPickupSeconds: offer.etaSeconds,
      tripDistanceM: Number(detail.quoted_distance_m ?? 0),
      fareCents: fare,
      // Drivers care about take-home, not gross. Showing gross and letting
      // them discover the commission later is how you lose a fleet.
      driverEarningsCents: fare - Math.round((fare * commissionBps) / 10_000),
      surgeMultiplier: Number(detail.surge_multiplier),
      riderRating: Number(detail.rider_rating),
      paymentMethod: detail.payment_method,
    });
  }

  /**
   * Waits for the driver's answer. Resolution comes through a Redis key the
   * accept/decline handler sets — polling a local promise map would break the
   * moment the driver's socket lands on a different gateway node.
   */
  private async awaitResponse(
    rideId: string,
    driverId: string,
    ttlSeconds: number,
  ): Promise<'accepted' | 'declined' | 'timeout'> {
    const key = `offer:response:${rideId}:${driverId}`;
    const deadline = Date.now() + ttlSeconds * 1000;

    while (Date.now() < deadline) {
      const response = await this.redis.get(key);
      if (response === 'accepted' || response === 'declined') {
        await this.redis.del(key);
        return response;
      }
      await this.sleep(250);
    }
    return 'timeout';
  }

  // ===================================================================
  // Claiming
  // ===================================================================

  /**
   * Atomic claim. The conditional UPDATE is the entire concurrency control:
   * whichever driver's statement lands first sets driver_id, and the second
   * updates zero rows and is told the ride was taken.
   */
  async claim(rideId: string, driverId: string, offerToken: string) {
    const expected = await this.redis.get(`offer:${rideId}:${driverId}`);
    if (!expected || expected !== offerToken) {
      this.logger.warn(`rejected claim ride=${rideId} driver=${driverId}: bad offer token`);
      return null;
    }

    const [claimed] = await this.db.query(
      `UPDATE rides r
          SET driver_id = $2,
              vehicle_id = d.active_vehicle_id,
              status = 'accepted',
              accepted_at = now()
         FROM drivers d
        WHERE r.id = $1
          AND d.id = $2
          AND r.driver_id IS NULL
          AND r.status IN ('requested', 'searching')
        RETURNING r.id`,
      [rideId, driverId],
    );

    if (!claimed) return null;

    await this.redis.set(`offer:response:${rideId}:${driverId}`, 'accepted', 'EX', 30);
    await this.db.query(
      `UPDATE drivers SET state = 'en_route_pickup' WHERE id = $1`,
      [driverId],
    );
    // Out of the idle pool until the trip ends.
    const [driver] = await this.db.query(
      `SELECT v.category FROM drivers d JOIN vehicles v ON v.id = d.active_vehicle_id
        WHERE d.id = $1`,
      [driverId],
    );
    if (driver) {
      await this.dispatch.removeDriverFromPool(driverId, driver.category);
    }

    const [profile] = await this.db.query(
      `SELECT u.full_name, u.rating_avg, u.phone, d.completed_trips,
              v.plate_number, v.make, v.model, v.colour, v.category
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         JOIN vehicles v ON v.id = d.active_vehicle_id
        WHERE d.id = $1`,
      [driverId],
    );

    return {
      driverPublicProfile: {
        name: profile.full_name,
        rating: Number(profile.rating_avg),
        trips: Number(profile.completed_trips),
        // Masked behind a voice proxy in production; the raw number is never
        // handed to the rider.
        phoneMasked: this.maskPhone(profile.phone),
      },
      vehicle: {
        plate: profile.plate_number,
        make: profile.make,
        model: profile.model,
        colour: profile.colour,
        category: profile.category,
      },
      etaSeconds: 0,
    };
  }

  async declineOffer(rideId: string, driverId: string, reason?: string): Promise<void> {
    await this.redis.set(`offer:response:${rideId}:${driverId}`, 'declined', 'EX', 30);
    await this.db.query(
      `UPDATE ride_offers SET responded_at = now(), outcome = 'declined'
        WHERE ride_id = $1 AND driver_id = $2 AND outcome IS NULL`,
      [rideId, driverId],
    );
    if (reason) this.logger.debug(`decline ride=${rideId} driver=${driverId}: ${reason}`);
  }

  // ===================================================================
  // Transitions
  // ===================================================================

  /**
   * Validates and applies a status transition. A replayed 'completed' after a
   * reconnect must not close a trip twice or charge twice, so every
   * transition is guarded by the current status in the WHERE clause.
   */
  async transition(
    rideId: string,
    driverId: string,
    status: 'arrived' | 'in_progress' | 'completed',
    at: Date,
  ) {
    const allowedFrom: Record<string, string[]> = {
      arrived: ['accepted'],
      in_progress: ['accepted', 'arrived'],
      completed: ['in_progress'],
    };

    if (status !== 'completed') {
      const column = status === 'arrived' ? 'arrived_at' : 'started_at';
      const [row] = await this.db.query(
        `UPDATE rides SET status = $3::ride_status, ${column} = $4
          WHERE id = $1 AND driver_id = $2 AND status = ANY($5::ride_status[])
          RETURNING *`,
        [rideId, driverId, status, at, allowedFrom[status]],
      );
      if (!row) throw new BadRequestException('invalid_transition');

      await this.db.query(
        `UPDATE drivers SET state = $2::driver_state WHERE id = $1`,
        [driverId, status === 'arrived' ? 'at_pickup' : 'on_trip'],
      );
      return this.rowToRide(row);
    }

    return this.complete(rideId, driverId, at);
  }

  /**
   * Closes the trip and settles the fare. Distance comes from the breadcrumb
   * trail in PostGIS, not from the device.
   */
  private async complete(rideId: string, driverId: string, at: Date) {
    const [ride] = await this.db.query(
      `SELECT r.*, ST_Y(r.pickup_point::geometry) AS pickup_lat,
              ST_X(r.pickup_point::geometry) AS pickup_lng
         FROM rides r
        WHERE r.id = $1 AND r.driver_id = $2 AND r.status = 'in_progress'`,
      [rideId, driverId],
    );
    if (!ride) throw new BadRequestException('invalid_transition');

    // ST_Length over the ordered breadcrumb line gives the driven distance.
    // Falling back to the quote when the trace is too sparse is deliberate:
    // a GPS outage should not produce a 200 TZS fare for a 12 km trip.
    const [measured] = await this.db.query(
      `SELECT
         COALESCE(ST_Length(ST_MakeLine(position::geometry ORDER BY recorded_at)::geography), 0) AS distance_m,
         COUNT(*) AS points
       FROM locations
      WHERE ride_id = $1`,
      [rideId],
    );

    const tracedDistance = Number(measured?.distance_m ?? 0);
    const enoughPoints = Number(measured?.points ?? 0) >= 5;
    const distanceM = enoughPoints && tracedDistance > 0
      ? Math.round(tracedDistance)
      : Number(ride.quoted_distance_m ?? 0);

    const durationS = Math.max(
      0,
      Math.round((at.getTime() - new Date(ride.started_at).getTime()) / 1000),
    );

    const { fare, needsReview } = await this.fares.settle(
      {
        category: ride.requested_category,
        distanceMetres: distanceM,
        durationSeconds: durationS,
        waitingSeconds: ride.waiting_seconds ?? 0,
        pickup: { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) },
        lockedSurge: Number(ride.surge_multiplier),
      },
      Number(ride.quoted_fare_cents),
    );

    const [updated] = await this.db.query(
      `UPDATE rides
          SET status = 'completed',
              completed_at = $2,
              actual_distance_m = $3,
              actual_duration_s = $4,
              final_fare_cents = $5,
              commission_cents = $6,
              booking_fee_cents = $7,
              vat_cents = $8,
              driver_earnings_cents = $9
        WHERE id = $1
        RETURNING *`,
      [
        rideId,
        at,
        distanceM,
        durationS,
        fare.totalFareCents,
        fare.commissionCents,
        fare.bookingFeeCents,
        fare.vatOnCommissionCents,
        fare.driverEarningsCents,
      ],
    );

    // Cash trips: the driver already holds the money, so the commission
    // becomes a debt against their wallet. Past the floor they stop getting
    // offers until they settle.
    if (ride.payment_method === 'cash') {
      await this.db.query(
        `UPDATE drivers
            SET wallet_balance_cents = wallet_balance_cents - $2,
                completed_trips = completed_trips + 1,
                state = 'online_idle'
          WHERE id = $1`,
        [driverId, fare.commissionCents],
      );
    } else {
      await this.db.query(
        `UPDATE drivers
            SET completed_trips = completed_trips + 1, state = 'online_idle'
          WHERE id = $1`,
        [driverId],
      );
    }

    if (needsReview) {
      this.logger.warn(`ride ${rideId} settled above quote tolerance — flagged for review`);
    }

    return this.rowToRide(updated);
  }

  async cancel(rideId: string, byUserId: string, reason?: string) {
    const [ride] = await this.db.query(
      `SELECT r.*, ST_Y(r.pickup_point::geometry) AS lat,
              ST_X(r.pickup_point::geometry) AS lng
         FROM rides r WHERE r.id = $1`,
      [rideId],
    );
    if (!ride) throw new BadRequestException('ride_not_found');

    const byRider = ride.rider_id === byUserId;
    const secondsSinceAccept = ride.accepted_at
      ? (Date.now() - new Date(ride.accepted_at).getTime()) / 1000
      : 0;

    const feeCents = byRider
      ? await this.fares.cancellationFee(
          ride.requested_category,
          { lat: Number(ride.lat), lng: Number(ride.lng) },
          secondsSinceAccept,
          Boolean(ride.arrived_at),
        )
      : 0;

    await this.db.query(
      `UPDATE rides
          SET status = $2::ride_status, cancelled_at = now(),
              cancellation_reason = $3, final_fare_cents = $4
        WHERE id = $1 AND status NOT IN ('completed', 'cancelled_by_rider', 'cancelled_by_driver')`,
      [
        rideId,
        byRider ? 'cancelled_by_rider' : 'cancelled_by_driver',
        reason ?? null,
        feeCents || null,
      ],
    );

    if (ride.driver_id) {
      await this.db.query(
        `UPDATE drivers SET state = 'online_idle' WHERE id = $1`,
        [ride.driver_id],
      );
    }

    this.gateway.server.to(`ride:${rideId}`).emit('ride:status_change', {
      rideId,
      status: byRider ? 'cancelled_by_rider' : 'cancelled_by_driver',
      cancellationFeeCents: feeCents,
    });

    return { cancelled: true, feeCents };
  }

  // ===================================================================
  // Ratings
  // ===================================================================

  /**
   * Records a one-to-five star rating and updates the recipient's average.
   *
   * Column meaning, since the names invite confusion:
   *   rides.driver_rating = the stars the RIDER gave the DRIVER
   *   rides.rider_rating  = the stars the DRIVER gave the RIDER
   *
   * The caller's role is derived from the ride, never trusted from the
   * request, so neither party can rate themselves.
   *
   * The average is derived from an integer sum rather than updated in place,
   * so it stays exact no matter how many trips a driver completes.
   */
  async rate(
    rideId: string,
    raterUserId: string,
    stars: number,
    comment?: string,
  ) {
    const [ride] = await this.db.query(
      `SELECT r.id, r.status, r.rider_id, r.driver_id,
              r.rider_rating, r.driver_rating,
              d.user_id AS driver_user_id
         FROM rides r
         LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE r.id = $1`,
      [rideId],
    );

    if (!ride) throw new BadRequestException('ride_not_found');
    if (ride.status !== 'completed') {
      throw new BadRequestException('ride is not complete');
    }

    const isRider = ride.rider_id === raterUserId;
    const isDriver = ride.driver_user_id === raterUserId;
    if (!isRider && !isDriver) throw new BadRequestException('not_your_ride');

    // Column the rating lands in, and whose average it moves.
    const column = isRider ? 'driver_rating' : 'rider_rating';
    const recipientUserId = isRider ? ride.driver_user_id : ride.rider_id;
    if (!recipientUserId) throw new BadRequestException('no_counterparty');

    // Ratings are final. Allowing a re-rate invites pressure on the driver to
    // ask a rider to change it.
    if (ride[column] != null) {
      return { alreadyRated: true, stars: Number(ride[column]) };
    }

    await this.db.transaction(async (manager) => {
      await manager.query(
        `UPDATE rides SET ${column} = $2 WHERE id = $1`,
        [rideId, stars],
      );

      // The average is DERIVED from the integer sum, never updated in place.
      // Updating a rounded average on every rating accumulated up to 0.10
      // stars of drift in simulation, which matters when drivers are
      // deactivated on rating thresholds.
      await manager.query(
        `UPDATE users
            SET rating_sum = rating_sum + $2,
                rating_count = rating_count + 1,
                rating_avg = round(
                  (rating_sum + $2)::numeric / (rating_count + 1), 2)
          WHERE id = $1`,
        [recipientUserId, stars],
      );
    });

    if (comment && comment.trim().length > 0) {
      this.logger.log(`rating comment ride=${rideId} stars=${stars}`);
    }

    return { rated: true, stars };
  }

  // ===================================================================
  // Breadcrumbs
  // ===================================================================

  /**
   * Buffers in memory and flushes in batches. One INSERT per ping would put
   * thousands of tiny writes per second on the primary; batching turns that
   * into a handful of multi-row inserts.
   */
  async enqueueBreadcrumb(input: BreadcrumbInput): Promise<void> {
    this.breadcrumbBuffer.push(input);
    if (this.breadcrumbBuffer.length >= 200) await this.flushBreadcrumbs();
  }

  async flushBreadcrumbs(): Promise<void> {
    if (this.breadcrumbBuffer.length === 0) return;

    const batch = this.breadcrumbBuffer;
    this.breadcrumbBuffer = [];

    const values = batch
      .map(
        (_, i) =>
          `($${i * 8 + 1}, $${i * 8 + 2}, ST_SetSRID(ST_MakePoint($${i * 8 + 3}, $${i * 8 + 4}), 4326)::geography, ` +
          `$${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8}, now(), $${i * 8 + 8})`,
      )
      .join(', ');

    const params = batch.flatMap((b) => [
      b.driverId,
      b.rideId,
      b.lng,
      b.lat,
      b.headingDeg,
      b.speedKph,
      b.accuracyM,
      b.recordedAt,
    ]);

    try {
      await this.db.query(
        `INSERT INTO locations
           (driver_id, ride_id, position, heading_deg, speed_kph, accuracy_m, recorded_at, received_at, is_backfilled)
         SELECT driver_id, ride_id, position, heading_deg, speed_kph, accuracy_m, recorded_at, received_at, FALSE
           FROM (VALUES ${values}) AS v(driver_id, ride_id, position, heading_deg, speed_kph, accuracy_m, recorded_at, received_at, dup)`,
        params,
      );
    } catch (err) {
      // Losing breadcrumbs degrades the trip trace but must never break the
      // socket path, so this is logged rather than thrown.
      this.logger.error(`breadcrumb flush failed (${batch.length} rows): ${(err as Error).message}`);
    }
  }

  // ===================================================================
  // Reads
  // ===================================================================

  async findActiveForUser(userId: string) {
    const rows = await this.db.query(
      `SELECT r.* FROM rides r
         LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE (r.rider_id = $1 OR d.user_id = $1)
          AND r.status IN ('requested','searching','accepted','arrived','in_progress')
        ORDER BY r.requested_at DESC`,
      [userId],
    );
    return rows.map((r: any) => this.rowToRide(r));
  }

  async history(userId: string, limit = 20, offset = 0) {
    return this.db.query(
      `SELECT r.id, r.reference, r.status, r.requested_at, r.completed_at,
              r.pickup_address, r.dropoff_address, r.final_fare_cents,
              r.requested_category, r.payment_method
         FROM rides r
         LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE r.rider_id = $1 OR d.user_id = $1
        ORDER BY r.requested_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, Math.min(limit, 100), offset],
    );
  }

  toWireSummary(ride: any) {
    return {
      rideId: ride.id,
      reference: ride.reference,
      status: ride.status,
      category: ride.requestedCategory ?? ride.requested_category,
      quotedFareCents: Number(ride.quotedFareCents ?? ride.quoted_fare_cents ?? 0),
      finalFareCents: ride.finalFareCents ?? ride.final_fare_cents ?? null,
      paymentMethod: ride.paymentMethod ?? ride.payment_method,
      isPaid: ride.isPaid ?? ride.is_paid ?? false,
      at: Date.now(),
    };
  }

  private rowToRide(row: any) {
    return {
      ...row,
      id: row.id,
      finalFareCents: row.final_fare_cents ? Number(row.final_fare_cents) : null,
      actualDistanceM: row.actual_distance_m,
      actualDurationS: row.actual_duration_s,
      paymentMethod: row.payment_method,
    };
  }

  // ===================================================================
  // Helpers
  // ===================================================================

  /** Human-readable, unambiguous over a phone line: no O/0 or I/1 confusion. */
  private generateReference(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return `TZ-${code}`;
  }

  private signOfferToken(rideId: string, driverId: string): string {
    return crypto
      .createHmac('sha256', process.env.OFFER_TOKEN_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'dev')
      .update(`${rideId}:${driverId}:${Math.floor(Date.now() / 1000)}`)
      .digest('base64url');
  }

  private maskPhone(phone: string): string {
    return phone.replace(/^(\+255)(\d{3})(\d{3})(\d{3})$/, '$1 $2 *** $4');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
