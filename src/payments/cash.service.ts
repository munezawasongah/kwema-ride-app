/**
 * Cash settlement.
 *
 * Cash is not a legacy method in this market — it is the majority of boda and
 * bajaji trips. Treating it as an afterthought is how ride-hailing platforms
 * end up with drivers who owe six weeks of uncollected commission.
 *
 * The mechanics: on a cash trip the driver physically holds the full fare, so
 * the platform's commission becomes a debt against their wallet. Past a
 * configured floor they stop receiving offers until they settle, which they
 * do by pushing money back via mobile money.
 *
 * Two safeguards that matter in practice:
 *
 *   * The debt ceiling is proportional, not a flat number. A driver doing
 *     forty trips a day accrues commission far faster than one doing five,
 *     and a flat ceiling either strangles the busy driver or lets the casual
 *     one drift.
 *   * Confirmation is the driver's action, not automatic on trip completion.
 *     A rider who runs off without paying is a real event, and recording it
 *     as collected would quietly bill the driver for a fare they never got.
 */

import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';

/** Base debt ceiling in cents: 30,000 TZS. */
const BASE_DEBT_CEILING_CENTS = 3_000_000;
/** Additional headroom per completed trip, capped. */
const HEADROOM_PER_TRIP_CENTS = 5_000;
const MAX_DEBT_CEILING_CENTS = 15_000_000; // 150,000 TZS

@Injectable()
export class CashService {
  private readonly logger = new Logger(CashService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Driver confirms they received the cash. Only then is commission booked.
   */
  async confirmCollection(rideId: string, driverId: string) {
    const [ride] = await this.db.query(
      `SELECT id, driver_id, status, payment_method, final_fare_cents,
              commission_cents, is_paid
         FROM rides WHERE id = $1`,
      [rideId],
    );

    if (!ride) throw new BadRequestException('ride_not_found');
    if (ride.driver_id !== driverId) throw new BadRequestException('not_your_ride');
    if (ride.payment_method !== 'cash') {
      throw new BadRequestException('ride is not a cash trip');
    }
    if (ride.status !== 'completed') {
      throw new BadRequestException('ride is not complete');
    }
    if (ride.is_paid) return { alreadyConfirmed: true };

    const commission = Number(ride.commission_cents ?? 0);

    await this.db.transaction(async (manager) => {
      await manager.query(`UPDATE rides SET is_paid = TRUE WHERE id = $1`, [rideId]);

      // The driver holds the fare, so the platform's share is a debt.
      await manager.query(
        `UPDATE drivers
            SET wallet_balance_cents = wallet_balance_cents - $2
          WHERE id = $1`,
        [driverId, commission],
      );

      await manager.query(
        `INSERT INTO transactions
           (ride_id, user_id, direction, method, amount_cents, status,
            external_reference, settled_at)
         SELECT $1, d.user_id, 'collection', 'cash', $2, 'success',
                'CASH-' || r.reference, now()
           FROM rides r JOIN drivers d ON d.id = r.driver_id
          WHERE r.id = $1
         ON CONFLICT (external_reference) DO NOTHING`,
        [rideId, Number(ride.final_fare_cents)],
      );
    });

    const status = await this.debtStatus(driverId);
    if (status.isBlocked) {
      await this.db.query(
        `UPDATE drivers SET state = 'offline' WHERE id = $1`,
        [driverId],
      );
      this.logger.warn(`driver ${driverId} blocked: cash debt ceiling reached`);
    }

    return { confirmed: true, commissionCents: commission, wallet: status };
  }

  /**
   * Current debt position and whether the driver may keep receiving offers.
   * The dispatch service reads the cached copy of this on every offer.
   */
  async debtStatus(driverId: string) {
    const [driver] = await this.db.query(
      `SELECT wallet_balance_cents, completed_trips FROM drivers WHERE id = $1`,
      [driverId],
    );
    if (!driver) throw new BadRequestException('driver_not_found');

    const balance = Number(driver.wallet_balance_cents);
    const ceiling = this.debtCeiling(Number(driver.completed_trips));
    const debt = balance < 0 ? -balance : 0;
    const isBlocked = debt >= ceiling;

    // Dispatch reads this floor from Redis rather than hitting Postgres on
    // every candidate scoring pass.
    await this.redis.hset(`driver:${driverId}`, {
      walletBalanceCents: balance.toString(),
      debtCeilingCents: ceiling.toString(),
    });

    return {
      balanceCents: balance,
      debtCents: debt,
      ceilingCents: ceiling,
      remainingCents: Math.max(0, ceiling - debt),
      isBlocked,
    };
  }

  /**
   * Proportional ceiling: base allowance plus headroom earned per completed
   * trip, capped. A new driver can accrue 30,000 TZS of commission debt; an
   * established one considerably more, because they turn it over faster.
   */
  private debtCeiling(completedTrips: number): number {
    return Math.min(
      BASE_DEBT_CEILING_CENTS + completedTrips * HEADROOM_PER_TRIP_CENTS,
      MAX_DEBT_CEILING_CENTS,
    );
  }

  /**
   * Credits a driver's wallet after they settle debt by mobile money.
   * Called from the mobile money webhook when the reference is a settlement
   * rather than a ride payment.
   */
  async creditSettlement(driverId: string, amountCents: number): Promise<void> {
    await this.db.query(
      `UPDATE drivers
          SET wallet_balance_cents = wallet_balance_cents + $2
        WHERE id = $1`,
      [driverId, amountCents],
    );

    const status = await this.debtStatus(driverId);
    if (!status.isBlocked) {
      this.logger.log(`driver ${driverId} cleared debt block`);
    }
  }
}
