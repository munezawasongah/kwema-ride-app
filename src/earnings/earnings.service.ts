/**
 * Driver earnings and settlement.
 *
 * The one thing to hold in mind reading this: gross fares are NOT what the
 * platform owes a driver, and driver earnings are NOT what the platform pays
 * out. On a cash trip the driver has already been paid in full by the rider
 * and owes commission back; on a digital trip the platform holds the money
 * and owes the driver their share.
 *
 * `drivers.wallet_balance_cents` is the net of those two, and it is the only
 * number that answers "what do we actually pay this person".
 */

import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import * as crypto from 'node:crypto';

import { REDIS } from '../common/redis.module';

export type Period = 'today' | 'week' | 'month' | 'all' | 'custom';

export interface EarningsSummary {
  from: string;
  to: string;
  trips: number;
  cashTrips: number;
  digitalTrips: number;

  /** What riders were charged in total. */
  grossFaresCents: number;
  /** The platform's cut across all trips. */
  commissionCents: number;
  /** The driver's share across all trips — their actual earnings. */
  driverEarningsCents: number;

  /** Cash the driver physically holds. */
  cashCollectedCents: number;
  /** Commission owed back on that cash. */
  commissionOwedCents: number;
  /** Fares the platform collected digitally. */
  digitalCollectedCents: number;
  /** The driver's share of those, which the platform owes. */
  payableToDriverCents: number;

  /** Net position now. Positive: we owe them. Negative: they owe us. */
  walletBalanceCents: number;
  settlementDirection: 'we_owe_driver' | 'driver_owes_us' | 'settled';

  distanceKm: number;
  onlineTrips: number;
}

@Injectable()
export class EarningsService {
  private readonly logger = new Logger(EarningsService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ===================================================================
  // Driver-facing
  // ===================================================================

  /**
   * Earnings for a period. Dates are resolved in East Africa Time, not UTC:
   * a driver finishing at 01:00 would otherwise see their night split across
   * two days, and every such driver becomes a support ticket.
   */
  async summary(
    driverId: string,
    period: Period = 'today',
    fromInput?: string,
    toInput?: string,
  ): Promise<EarningsSummary> {
    const { from, to } = this.resolvePeriod(period, fromInput, toInput);

    const [row] = await this.db.query(
      `SELECT
         COALESCE(SUM(trips), 0)                    AS trips,
         COALESCE(SUM(cash_trips), 0)               AS cash_trips,
         COALESCE(SUM(digital_trips), 0)            AS digital_trips,
         COALESCE(SUM(gross_fares_cents), 0)        AS gross_fares_cents,
         COALESCE(SUM(commission_cents), 0)         AS commission_cents,
         COALESCE(SUM(driver_earnings_cents), 0)    AS driver_earnings_cents,
         COALESCE(SUM(cash_collected_cents), 0)     AS cash_collected_cents,
         COALESCE(SUM(commission_owed_cents), 0)    AS commission_owed_cents,
         COALESCE(SUM(digital_collected_cents), 0)  AS digital_collected_cents,
         COALESCE(SUM(payable_to_driver_cents), 0)  AS payable_to_driver_cents,
         COALESCE(SUM(distance_m), 0)               AS distance_m
       FROM driver_earnings_daily
      WHERE driver_id = $1 AND day >= $2::date AND day <= $3::date`,
      [driverId, from, to],
    );

    const [driver] = await this.db.query(
      `SELECT wallet_balance_cents, completed_trips FROM drivers WHERE id = $1`,
      [driverId],
    );
    if (!driver) throw new BadRequestException('driver_not_found');

    const balance = Number(driver.wallet_balance_cents);

    return {
      from,
      to,
      trips: Number(row.trips),
      cashTrips: Number(row.cash_trips),
      digitalTrips: Number(row.digital_trips),
      grossFaresCents: Number(row.gross_fares_cents),
      commissionCents: Number(row.commission_cents),
      driverEarningsCents: Number(row.driver_earnings_cents),
      cashCollectedCents: Number(row.cash_collected_cents),
      commissionOwedCents: Number(row.commission_owed_cents),
      digitalCollectedCents: Number(row.digital_collected_cents),
      payableToDriverCents: Number(row.payable_to_driver_cents),
      walletBalanceCents: balance,
      settlementDirection:
        balance > 0 ? 'we_owe_driver' : balance < 0 ? 'driver_owes_us' : 'settled',
      distanceKm: Math.round(Number(row.distance_m) / 100) / 10,
      onlineTrips: Number(driver.completed_trips),
    };
  }

  /** Day-by-day breakdown, for the earnings chart in the driver app. */
  async daily(driverId: string, days = 14) {
    return this.db.query(
      `SELECT day, trips, gross_fares_cents, driver_earnings_cents,
              cash_collected_cents, commission_owed_cents,
              payable_to_driver_cents
         FROM driver_earnings_daily
        WHERE driver_id = $1
          AND day >= (now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date
                     - ($2::int - 1)
        ORDER BY day DESC`,
      [driverId, days],
    );
  }

  /**
   * Per-trip statement. This is what settles an argument: every completed
   * trip, what the rider paid, how, the commission, and the driver's share.
   */
  async statement(driverId: string, from: string, to: string) {
    const rows = await this.db.query(
      `SELECT r.reference, r.completed_at, r.requested_category,
              r.payment_method, r.is_paid,
              r.actual_distance_m, r.final_fare_cents,
              r.commission_cents, r.booking_fee_cents,
              r.driver_earnings_cents,
              CASE WHEN r.payment_method = 'cash'
                   THEN -r.commission_cents
                   ELSE r.driver_earnings_cents
              END AS wallet_effect_cents
         FROM rides r
        WHERE r.driver_id = $1
          AND r.status = 'completed'
          AND (r.completed_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date
              BETWEEN $2::date AND $3::date
        ORDER BY r.completed_at DESC`,
      [driverId, from, to],
    );

    return rows.map((r: any) => ({
      reference: r.reference,
      completedAt: r.completed_at,
      category: r.requested_category,
      paymentMethod: r.payment_method,
      isPaid: r.is_paid,
      distanceKm: Math.round(Number(r.actual_distance_m ?? 0) / 100) / 10,
      fareCents: Number(r.final_fare_cents ?? 0),
      commissionCents: Number(r.commission_cents ?? 0),
      driverEarningsCents: Number(r.driver_earnings_cents ?? 0),
      // The signed effect on the driver's wallet. Negative on cash (debt
      // incurred), positive on digital (payable accrued).
      walletEffectCents: Number(r.wallet_effect_cents ?? 0),
    }));
  }

  // ===================================================================
  // Finance-facing
  // ===================================================================

  /**
   * Drivers the platform owes money to. This is the payout run.
   *
   * A minimum threshold avoids paying out 300 TZS and losing more than that
   * in mobile money transfer fees — the balance carries to the next run.
   */
  async payoutRun(minimumCents = 500_000) {
    return this.db.query(
      `SELECT d.id AS driver_id, u.full_name, u.phone,
              d.wallet_balance_cents, d.completed_trips
         FROM drivers d
         JOIN users u ON u.id = d.user_id
        WHERE d.wallet_balance_cents >= $1
        ORDER BY d.wallet_balance_cents DESC`,
      [minimumCents],
    );
  }

  /** Drivers carrying cash-commission debt, worst first. */
  async debtorRun() {
    return this.db.query(
      `SELECT d.id AS driver_id, u.full_name, u.phone,
              -d.wallet_balance_cents AS debt_cents,
              d.debt_ceiling_cents,
              d.wallet_balance_cents <= -d.debt_ceiling_cents AS is_blocked
         FROM drivers d
         JOIN users u ON u.id = d.user_id
        WHERE d.wallet_balance_cents < 0
        ORDER BY d.wallet_balance_cents ASC`,
    );
  }

  /**
   * Records a payout and moves the wallet, in one transaction.
   *
   * The balance before and after are stored on the settlement row so a
   * disputed statement can be reconstructed exactly, rather than re-derived
   * from data that has moved on since.
   */
  async recordPayout(
    driverId: string,
    amountCents: number,
    createdBy: string,
    opts: { periodStart?: string; periodEnd?: string; notes?: string } = {},
  ) {
    if (amountCents <= 0) throw new BadRequestException('amount must be positive');

    return this.db.transaction(async (manager) => {
      // Lock the row: a concurrent payout run must not read a stale balance
      // and pay the same money twice.
      const [driver] = await manager.query(
        `SELECT wallet_balance_cents FROM drivers WHERE id = $1 FOR UPDATE`,
        [driverId],
      );
      if (!driver) throw new BadRequestException('driver_not_found');

      const before = Number(driver.wallet_balance_cents);
      if (amountCents > before) {
        throw new BadRequestException(
          `cannot pay ${amountCents} when balance is ${before}`,
        );
      }
      const after = before - amountCents;

      await manager.query(
        `UPDATE drivers SET wallet_balance_cents = $2 WHERE id = $1`,
        [driverId, after],
      );

      const [settlement] = await manager.query(
        `INSERT INTO driver_settlements
           (driver_id, direction, amount_cents, balance_before_cents,
            balance_after_cents, period_start, period_end, status,
            external_reference, created_by, notes)
         VALUES ($1, 'disbursement', $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
         RETURNING id, external_reference`,
        [
          driverId,
          amountCents,
          before,
          after,
          opts.periodStart ?? null,
          opts.periodEnd ?? null,
          `PAYOUT-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
          createdBy,
          opts.notes ?? null,
        ],
      );

      await this.redis.hset(`driver:${driverId}`, {
        walletBalanceCents: after.toString(),
      });

      return {
        settlementId: settlement.id,
        reference: settlement.external_reference,
        balanceBeforeCents: before,
        balanceAfterCents: after,
      };
    });
  }

  /**
   * Cross-checks the ledger against the trips.
   *
   * Catches the failure that matters: a completed ride whose money never
   * moved. A payment marked collected with no transaction row, or a cash trip
   * the driver never confirmed, both surface here rather than as a driver
   * asking why they are short.
   */
  async reconcile(from: string, to: string) {
    const [totals] = await this.db.query(
      `SELECT
         COUNT(*)                                      AS completed_rides,
         COUNT(*) FILTER (WHERE NOT is_paid)           AS unpaid_rides,
         COALESCE(SUM(final_fare_cents), 0)            AS rides_total_cents,
         COALESCE(SUM(final_fare_cents) FILTER (WHERE NOT is_paid), 0)
                                                       AS unpaid_total_cents
       FROM rides
      WHERE status = 'completed'
        AND (completed_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date
            BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    const [collected] = await this.db.query(
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS collected_cents,
              COUNT(*)                          AS transactions
         FROM transactions t
         JOIN rides r ON r.id = t.ride_id
        WHERE t.direction = 'collection'
          AND t.status = 'success'
          AND (r.completed_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date
              BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    const ridesTotal = Number(totals.rides_total_cents);
    const collectedTotal = Number(collected.collected_cents);

    return {
      from,
      to,
      completedRides: Number(totals.completed_rides),
      unpaidRides: Number(totals.unpaid_rides),
      ridesTotalCents: ridesTotal,
      collectedTotalCents: collectedTotal,
      unpaidTotalCents: Number(totals.unpaid_total_cents),
      // Anything other than zero here means a trip completed without its
      // money being accounted for. Investigate before the payout run.
      varianceCents: ridesTotal - collectedTotal,
      transactions: Number(collected.transactions),
    };
  }

  // ===================================================================
  // Helpers
  // ===================================================================

  /** All boundaries in East Africa Time; the business day is local. */
  private resolvePeriod(period: Period, from?: string, to?: string) {
    const now = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Africa/Dar_es_Salaam' }),
    );
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    switch (period) {
      case 'today':
        return { from: iso(now), to: iso(now) };
      case 'week': {
        // Week starts Monday: Tanzanian driver pay cycles run Monday to Sunday.
        const start = new Date(now);
        const offset = (start.getDay() + 6) % 7;
        start.setDate(start.getDate() - offset);
        return { from: iso(start), to: iso(now) };
      }
      case 'month': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { from: iso(start), to: iso(now) };
      }
      case 'all':
        return { from: '2020-01-01', to: iso(now) };
      case 'custom':
        if (!from || !to) {
          throw new BadRequestException('custom period needs from and to');
        }
        return { from, to };
    }
  }
}
