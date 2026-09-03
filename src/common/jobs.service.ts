/**
 * Scheduled background work.
 *
 * These three jobs are what keep the system honest between requests:
 * surge tiles reflect reality, breadcrumbs reach the database, and payments
 * whose callbacks were lost still get resolved.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';

import { FareService } from '../pricing/fare.service';
import { RidesService } from '../rides/rides.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly fares: FareService,
    private readonly rides: RidesService,
    private readonly payments: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async refreshSurge(): Promise<void> {
    try {
      await this.fares.refreshSurgeTiles();
    } catch (err) {
      this.logger.error(`surge refresh failed: ${(err as Error).message}`);
    }
  }

  @Interval(5_000)
  async flushBreadcrumbs(): Promise<void> {
    await this.rides.flushBreadcrumbs();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcilePayments(): Promise<void> {
    try {
      await this.payments.reconcilePending();
    } catch (err) {
      this.logger.error(`payment reconciliation failed: ${(err as Error).message}`);
    }
  }

  /**
   * Creates next month's breadcrumb partition ahead of time. Without this the
   * first insert after month-end fails, which would silently stop the trip
   * trace — and the fare depends on it.
   */
  @Cron('0 3 25 * *')
  async ensureNextPartition(): Promise<void> {
    try {
      await this.rides['db'].query(`
        DO $$
        DECLARE
          start_date DATE := date_trunc('month', now() + interval '1 month')::date;
          end_date   DATE := date_trunc('month', now() + interval '2 months')::date;
          part_name  TEXT := 'locations_' || to_char(start_date, 'YYYY_MM');
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
            EXECUTE format(
              'CREATE TABLE %I PARTITION OF locations FOR VALUES FROM (%L) TO (%L)',
              part_name, start_date, end_date);
          END IF;
        END $$;
      `);
    } catch (err) {
      this.logger.error(`partition creation failed: ${(err as Error).message}`);
    }
  }
}
