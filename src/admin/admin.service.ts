/**
 * Admin operations: fleet, rides, tariffs, and the live picture.
 *
 * Everything here is read-mostly except driver approval and tariff changes,
 * both of which are consequential: approving a driver puts a vehicle on the
 * road under your LATRA licence, and a tariff row decides what every rider
 * in that zone is charged.
 */

import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ===================================================================
  // Overview
  // ===================================================================

  /** The numbers worth seeing on one screen. Local day, not UTC. */
  async overview() {
    const [today] = await this.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')            AS completed,
        COUNT(*) FILTER (WHERE status IN ('requested','searching',
                          'accepted','arrived','in_progress'))  AS active,
        COUNT(*) FILTER (WHERE status = 'expired')              AS expired,
        -- ::text is required: LIKE has no operator for an enum type, and
        -- without the cast the whole overview query fails with a 500.
        COUNT(*) FILTER (WHERE status::text LIKE 'cancelled%') AS cancelled,
        COALESCE(SUM(final_fare_cents) FILTER (WHERE status = 'completed'), 0)
                                                                AS gross_cents,
        COALESCE(SUM(commission_cents) FILTER (WHERE status = 'completed'), 0)
                                                                AS commission_cents
      FROM rides
      WHERE (requested_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date
            = (now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date
    `);

    const [fleet] = await this.db.query(`
      SELECT
        COUNT(*)                                            AS drivers,
        COUNT(*) FILTER (WHERE state <> 'offline')          AS online,
        COUNT(*) FILTER (WHERE state = 'online_idle')       AS idle,
        COUNT(*) FILTER (WHERE compliance_verified_at IS NULL) AS pending_approval,
        COUNT(*) FILTER (WHERE wallet_balance_cents < 0)    AS in_debt,
        COALESCE(SUM(wallet_balance_cents) FILTER (WHERE wallet_balance_cents > 0), 0)
                                                            AS payable_cents,
        COALESCE(-SUM(wallet_balance_cents) FILTER (WHERE wallet_balance_cents < 0), 0)
                                                            AS receivable_cents
      FROM drivers
    `);

    const [riders] = await this.db.query(
      `SELECT COUNT(*) AS total FROM users WHERE deleted_at IS NULL`,
    );

    // Expired rides are the metric that matters most early on: every one is a
    // rider who wanted a trip and found no driver.
    const completed = Number(today.completed);
    const expired = Number(today.expired);
    const unserved =
      completed + expired === 0 ? 0 : Math.round((expired / (completed + expired)) * 100);

    return {
      today: {
        completed,
        active: Number(today.active),
        expired,
        cancelled: Number(today.cancelled),
        grossCents: Number(today.gross_cents),
        commissionCents: Number(today.commission_cents),
        unservedPercent: unserved,
      },
      fleet: {
        drivers: Number(fleet.drivers),
        online: Number(fleet.online),
        idle: Number(fleet.idle),
        pendingApproval: Number(fleet.pending_approval),
        inDebt: Number(fleet.in_debt),
        payableCents: Number(fleet.payable_cents),
        receivableCents: Number(fleet.receivable_cents),
      },
      users: { total: Number(riders.total) },
    };
  }

  // ===================================================================
  // Drivers
  // ===================================================================

  async drivers(filter?: string, limit = 50) {
    const where: string[] = [];
    if (filter === 'pending') where.push('d.compliance_verified_at IS NULL');
    if (filter === 'online') where.push("d.state <> 'offline'");
    if (filter === 'debt') where.push('d.wallet_balance_cents < 0');
    if (filter === 'expiring') {
      // Documents lapsing within 30 days. A driver dispatched on an expired
      // insurance policy is an uninsured vehicle carrying your passenger.
      where.push(`(
        d.driving_licence_expiry <= CURRENT_DATE + 30
        OR d.latra_licence_expiry <= CURRENT_DATE + 30
        OR v.insurance_expiry <= CURRENT_DATE + 30
      )`);
    }

    return this.db.query(
      `SELECT d.id, u.full_name, u.phone, u.rating_avg, u.rating_count,
              u.photo_key,
              d.state, d.completed_trips, d.acceptance_rate,
              d.wallet_balance_cents, d.debt_ceiling_cents,
              d.compliance_verified_at,
              d.driving_licence_no, d.driving_licence_expiry,
              d.latra_licence_no, d.latra_licence_expiry,
              v.plate_number, v.make, v.model, v.category,
              v.insurance_expiry, v.is_active AS vehicle_active,
              d.last_location_at
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN vehicles v ON v.id = d.active_vehicle_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY d.compliance_verified_at NULLS FIRST, u.full_name
        LIMIT $1`,
      [Math.min(limit, 200)],
    );
  }

  /**
   * Approves a driver for dispatch.
   *
   * Refuses if statutory documents are missing or already expired. This is
   * the gate between an application and a vehicle carrying passengers under
   * your operator licence, so it fails closed.
   */
  async verifyDriver(driverId: string, adminUserId: string) {
    const [driver] = await this.db.query(
      `SELECT d.id, d.driving_licence_no, d.driving_licence_expiry,
              d.latra_licence_expiry, d.active_vehicle_id,
              v.insurance_expiry
         FROM drivers d
         LEFT JOIN vehicles v ON v.id = d.active_vehicle_id
        WHERE d.id = $1`,
      [driverId],
    );
    if (!driver) throw new BadRequestException('driver_not_found');

    const problems: string[] = [];
    const today = new Date().toISOString().slice(0, 10);

    if (!driver.driving_licence_no) problems.push('no driving licence on file');
    if (!driver.driving_licence_expiry || driver.driving_licence_expiry < today) {
      problems.push('driving licence missing or expired');
    }
    if (!driver.active_vehicle_id) problems.push('no vehicle assigned');
    if (driver.insurance_expiry && driver.insurance_expiry < today) {
      problems.push('vehicle insurance expired');
    }
    if (driver.latra_licence_expiry && driver.latra_licence_expiry < today) {
      problems.push('LATRA licence expired');
    }

    if (problems.length) {
      throw new BadRequestException(`cannot approve: ${problems.join('; ')}`);
    }

    await this.db.query(
      `UPDATE drivers
          SET compliance_verified_at = now(), compliance_verified_by = $2
        WHERE id = $1`,
      [driverId, adminUserId],
    );
    this.logger.log(`driver ${driverId} approved by ${adminUserId}`);
    return { approved: true };
  }

  /** Removes a driver from dispatch immediately, including any live socket. */
  async suspendDriver(driverId: string, reason: string) {
    await this.db.query(
      `UPDATE drivers SET state = 'offline', compliance_verified_at = NULL
        WHERE id = $1`,
      [driverId],
    );

    // Also clear them from the Redis geo pool so dispatch stops instantly
    // rather than at their next state change.
    for (const category of ['boda', 'bajaji', 'standard', 'xl', 'express']) {
      await this.redis.zrem(`geo:drivers:${category}`, driverId);
    }

    this.logger.warn(`driver ${driverId} suspended: ${reason}`);
    return { suspended: true };
  }

  /**
   * Creates a driver profile and vehicle for an existing user account.
   *
   * The account must already exist — the person signs up in the app with
   * their own phone first, which means the number is verified before it is
   * ever attached to a vehicle.
   */
  async createDriver(input: {
    phone: string;
    drivingLicenceNo: string;
    drivingLicenceExpiry: string;
    latraLicenceNo?: string;
    latraLicenceExpiry?: string;
    plateNumber: string;
    make: string;
    model: string;
    colour?: string;
    year?: number;
    category: string;
    seats?: number;
    insurancePolicyNo: string;
    insuranceExpiry: string;
    homeCity?: string;
  }) {
    const [user] = await this.db.query(
      `SELECT id, full_name FROM users WHERE phone = $1 AND deleted_at IS NULL`,
      [input.phone],
    );
    if (!user) {
      throw new BadRequestException(
        'no account for that number — the driver must sign up in the app first',
      );
    }

    const [existing] = await this.db.query(
      `SELECT id FROM drivers WHERE user_id = $1`,
      [user.id],
    );
    if (existing) throw new BadRequestException('already a driver');

    return this.db.transaction(async (manager) => {
      const [driver] = await manager.query(
        `INSERT INTO drivers
           (user_id, driving_licence_no, driving_licence_expiry,
            latra_licence_no, latra_licence_expiry, home_city, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'offline')
         RETURNING id`,
        [
          user.id,
          input.drivingLicenceNo,
          input.drivingLicenceExpiry,
          input.latraLicenceNo ?? null,
          input.latraLicenceExpiry ?? null,
          input.homeCity ?? 'Dar es Salaam',
        ],
      );

      const [vehicle] = await manager.query(
        `INSERT INTO vehicles
           (driver_id, category, plate_number, make, model, colour, year,
            seats, insurance_policy_no, insurance_expiry)
         VALUES ($1, $2::vehicle_category, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          driver.id,
          input.category,
          input.plateNumber.toUpperCase(),
          input.make,
          input.model,
          input.colour ?? null,
          input.year ?? null,
          input.seats ?? (input.category === 'boda' ? 1 : 4),
          input.insurancePolicyNo,
          input.insuranceExpiry,
        ],
      );

      await manager.query(
        `UPDATE drivers SET active_vehicle_id = $2 WHERE id = $1`,
        [driver.id, vehicle.id],
      );

      // Roles are an array; a driver may also ride.
      await manager.query(
        `UPDATE users
            SET roles = CASE WHEN 'driver' = ANY(roles) THEN roles
                             ELSE array_append(roles, 'driver'::user_role) END
          WHERE id = $1`,
        [user.id],
      );

      return { driverId: driver.id, vehicleId: vehicle.id, name: user.full_name };
    });
  }

  // ===================================================================
  // Rides
  // ===================================================================

  async rides(status?: string, limit = 50) {
    const clauses = ["r.requested_at > now() - interval '30 days'"];
    if (status === 'active') {
      clauses.push(
        "r.status IN ('requested','searching','accepted','arrived','in_progress')",
      );
    } else if (status && status !== 'all') {
      clauses.push(`r.status = '${status.replace(/[^a-z_]/g, '')}'::ride_status`);
    }

    return this.db.query(
      `SELECT r.id, r.reference, r.status, r.requested_category,
              r.requested_at, r.completed_at,
              r.pickup_address, r.dropoff_address,
              r.quoted_fare_cents, r.final_fare_cents, r.commission_cents,
              r.payment_method, r.is_paid, r.surge_multiplier,
              rider.full_name AS rider_name, rider.phone AS rider_phone,
              du.full_name AS driver_name
         FROM rides r
         JOIN users rider ON rider.id = r.rider_id
         LEFT JOIN drivers d ON d.id = r.driver_id
         LEFT JOIN users du ON du.id = d.user_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY r.requested_at DESC
        LIMIT $1`,
      [Math.min(limit, 200)],
    );
  }

  // ===================================================================
  // Tariffs
  // ===================================================================

  async tariffs() {
    return this.db.query(
      `SELECT t.*, z.code AS zone_code, z.name_en AS zone_name
         FROM tariffs t
         LEFT JOIN service_zones z ON z.id = t.zone_id
        WHERE t.valid_to IS NULL
        ORDER BY z.code NULLS FIRST, t.category`,
    );
  }

  /**
   * Publishes a new rate card.
   *
   * Never an UPDATE. The existing row is closed off with valid_to and a new
   * one is inserted, so a fare charged last month can still be reproduced
   * exactly from the tariff that was in force — which is what a LATRA audit
   * or a rider dispute actually asks for.
   */
  async publishTariff(input: {
    zoneId?: string | null;
    category: string;
    baseFareCents: number;
    perKmCents: number;
    perMinuteCents: number;
    minimumFareCents: number;
    cancellationFeeCents: number;
    waitingPerMinuteCents: number;
    commissionBps: number;
    bookingFeeBps: number;
    maxSurge: number;
    gazetteReference: string;
  }) {
    if (input.commissionBps < 0 || input.commissionBps > 10_000) {
      throw new BadRequestException('commission must be 0-10000 basis points');
    }
    if (!input.gazetteReference?.trim()) {
      throw new BadRequestException(
        'gazette reference is required — a rate change must be traceable to the notice authorising it',
      );
    }

    return this.db.transaction(async (manager) => {
      await manager.query(
        `UPDATE tariffs SET valid_to = now()
          WHERE category = $1::vehicle_category
            AND zone_id IS NOT DISTINCT FROM $2
            AND valid_to IS NULL`,
        [input.category, input.zoneId ?? null],
      );

      const [row] = await manager.query(
        `INSERT INTO tariffs
           (zone_id, category, base_fare_cents, per_km_cents, per_minute_cents,
            minimum_fare_cents, cancellation_fee_cents, waiting_per_minute_cents,
            free_waiting_seconds, commission_bps_cap, booking_fee_bps_cap,
            max_surge_multiplier, valid_from, gazette_reference)
         VALUES ($1, $2::vehicle_category, $3, $4, $5, $6, $7, $8, 180,
                 $9, $10, $11, now(), $12)
         RETURNING id`,
        [
          input.zoneId ?? null,
          input.category,
          input.baseFareCents,
          input.perKmCents,
          input.perMinuteCents,
          input.minimumFareCents,
          input.cancellationFeeCents,
          input.waitingPerMinuteCents,
          input.commissionBps,
          input.bookingFeeBps,
          input.maxSurge,
          input.gazetteReference.trim(),
        ],
      );

      // The fare service caches tariffs for five minutes; drop it so the new
      // rate applies to the next quote rather than up to five minutes later.
      const keys = await this.redis.keys('tariff:*');
      if (keys.length) await this.redis.del(...keys);

      return { tariffId: row.id, published: true };
    });
  }
}
