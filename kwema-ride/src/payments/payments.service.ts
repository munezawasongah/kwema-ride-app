/**
 * PaymentsService — see payments.controller.ts for the flow overview.
 */

import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';
import * as crypto from 'node:crypto';

import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AzamPayProvider, SelcomProvider, MobileMoneyProvider, Mno } from './mobile-money.providers';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly gateway: RealtimeGateway,
    private readonly azampay: AzamPayProvider,
    private readonly selcom: SelcomProvider,
  ) {}

  private provider(name: 'azampay' | 'selcom'): MobileMoneyProvider {
    return name === 'azampay' ? this.azampay : this.selcom;
  }

  /**
   * Routes an MNO to an aggregator. Ops can pin a rail to a specific
   * aggregator in Redis when one of them is having a bad night, without a
   * deploy.
   */
  private async routeProvider(mno: Mno): Promise<'azampay' | 'selcom'> {
    const override = await this.redis.get(`payments:route:${mno}`);
    if (override === 'azampay' || override === 'selcom') return override;
    return (process.env.DEFAULT_AGGREGATOR as 'azampay' | 'selcom') ?? 'azampay';
  }

  // -------------------------------------------------------------------
  // Initiation
  // -------------------------------------------------------------------

  async initiateCollection(userId: string, rideId: string, mno: Mno, payerPhone: string) {
    const [ride] = await this.db.query(
      `SELECT id, reference, rider_id, status, final_fare_cents, quoted_fare_cents, is_paid
         FROM rides WHERE id = $1`,
      [rideId],
    );
    if (!ride) throw new NotFoundException('ride not found');
    if (ride.rider_id !== userId) throw new ForbiddenException('not your ride');
    if (ride.is_paid) return { alreadyPaid: true, reference: null };

    const amountCents = Number(ride.final_fare_cents ?? ride.quoted_fare_cents);
    if (!amountCents || amountCents <= 0) {
      throw new BadRequestException('ride has no payable amount yet');
    }

    // Reuse an in-flight attempt rather than prompting the handset twice.
    const [existing] = await this.db.query(
      `SELECT external_reference, status FROM transactions
        WHERE ride_id = $1 AND status IN ('pending', 'processing')
        ORDER BY created_at DESC LIMIT 1`,
      [rideId],
    );
    if (existing) {
      return {
        reference: existing.external_reference,
        status: existing.status,
        message: 'A payment prompt is already active on your phone.',
      };
    }

    // Reference is unique and deterministic enough to be traceable in an
    // aggregator's portal during a dispute.
    const externalReference = `KWM-${ride.reference}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const aggregator = await this.routeProvider(mno);

    // Persist the intent BEFORE the network call.
    await this.db.query(
      `INSERT INTO transactions
         (ride_id, user_id, direction, method, provider, aggregator,
          amount_cents, status, external_reference, payer_phone)
       VALUES ($1, $2, 'collection', 'mobile_money', $3, $4, $5, 'pending', $6, $7)`,
      [rideId, userId, mno, aggregator, amountCents, externalReference, payerPhone],
    );

    try {
      const result = await this.provider(aggregator).initiateCollection({
        externalReference,
        amountCents,
        payerPhone,
        mno,
        rideReference: ride.reference,
        narration: `Kwema Ride ${ride.reference}`,
      });

      await this.db.query(
        `UPDATE transactions
            SET status = $2, aggregator_txn_id = $3, callback_payload = $4
          WHERE external_reference = $1`,
        [
          externalReference,
          result.accepted ? 'processing' : 'failed',
          result.aggregatorTxnId ?? null,
          JSON.stringify({ initiation: result.raw }),
        ],
      );

      return {
        reference: externalReference,
        status: result.accepted ? 'processing' : 'failed',
        // Copy is deliberately handset-specific: riders on Vodacom see a
        // different prompt from Airtel riders, and vague wording produces
        // support calls.
        message: result.accepted
          ? 'Angalia simu yako na uweke PIN yako.' // "Check your phone and enter your PIN."
          : result.message ?? 'Malipo hayakuanza. Jaribu tena.',
      };
    } catch (err) {
      // A timeout does NOT mean the push failed — the handset may already be
      // prompting. Leave it in `processing` for reconciliation rather than
      // marking it failed and letting the rider trigger a second charge.
      await this.db.query(
        `UPDATE transactions SET status = 'processing', failure_reason = $2
          WHERE external_reference = $1`,
        [externalReference, `initiation_error: ${(err as Error).message}`],
      );
      return {
        reference: externalReference,
        status: 'processing',
        message: 'Tunathibitisha malipo yako...', // "We are confirming your payment..."
      };
    }
  }

  // -------------------------------------------------------------------
  // Webhook handling
  // -------------------------------------------------------------------

  async handleWebhook(
    providerName: 'azampay' | 'selcom',
    headers: Record<string, string>,
    rawBody: Buffer,
  ): Promise<void> {
    const verification = this.provider(providerName).verifyWebhook(headers, rawBody);

    if (!verification.valid) {
      // Log and drop. Do not 4xx: a genuine aggregator with a rotated secret
      // would then retry forever, and an attacker learns nothing either way.
      this.logger.warn(`rejected ${providerName} webhook: ${verification.reason}`);
      return;
    }

    const ref = verification.externalReference;
    if (!ref) {
      this.logger.warn(`${providerName} webhook without external reference`);
      return;
    }

    // Idempotency guard. Aggregators re-deliver callbacks, sometimes minutes
    // apart, sometimes concurrently to two pods.
    const guard = await this.redis.set(`webhook:seen:${ref}`, '1', 'EX', 86_400, 'NX');
    if (guard !== 'OK') {
      this.logger.debug(`duplicate webhook ignored ref=${ref}`);
      return;
    }

    await this.db.transaction(async (manager) => {
      // Row lock so a concurrent reconciliation query cannot double-apply.
      const [txn] = await manager.query(
        `SELECT id, ride_id, user_id, amount_cents, status
           FROM transactions WHERE external_reference = $1 FOR UPDATE`,
        [ref],
      );

      if (!txn) {
        this.logger.warn(`webhook for unknown reference ${ref}`);
        return;
      }
      if (txn.status === 'success' || txn.status === 'reversed') return; // already terminal

      // Amount tampering check: the callback must match what we asked for.
      if (
        verification.amountCents !== undefined &&
        Math.abs(verification.amountCents - Number(txn.amount_cents)) > 100
      ) {
        this.logger.error(
          `amount mismatch ref=${ref} expected=${txn.amount_cents} got=${verification.amountCents}`,
        );
        await manager.query(
          `UPDATE transactions SET status = 'failed',
                  failure_reason = 'amount_mismatch', callback_payload = $2
            WHERE id = $1`,
          [txn.id, rawBody.toString('utf8')],
        );
        return;
      }

      const succeeded = verification.status === 'success';

      await manager.query(
        `UPDATE transactions
            SET status = $2,
                mno_receipt = $3,
                settled_at = CASE WHEN $2 = 'success' THEN now() ELSE settled_at END,
                failure_reason = $4,
                callback_payload = $5
          WHERE id = $1`,
        [
          txn.id,
          succeeded ? 'success' : verification.status === 'pending' ? 'processing' : 'failed',
          verification.mnoReceipt ?? null,
          succeeded ? null : verification.reason ?? null,
          rawBody.toString('utf8'),
        ],
      );

      if (succeeded) {
        await manager.query(
          `UPDATE rides SET is_paid = TRUE WHERE id = $1`,
          [txn.ride_id],
        );
        // Credit the driver's wallet with their share, net of commission.
        await manager.query(
          `UPDATE drivers d
              SET wallet_balance_cents = d.wallet_balance_cents + r.driver_earnings_cents
             FROM rides r
            WHERE r.id = $1 AND d.id = r.driver_id`,
          [txn.ride_id],
        );
      }
    });

    // Push the outcome to both apps so neither has to poll.
    const [row] = await this.db.query(
      `SELECT t.ride_id, t.user_id, t.status, t.mno_receipt, t.amount_cents,
              r.driver_id
         FROM transactions t JOIN rides r ON r.id = t.ride_id
        WHERE t.external_reference = $1`,
      [ref],
    );

    if (row) {
      this.gateway.server.to(`ride:${row.ride_id}`).emit('payment:status', {
        rideId: row.ride_id,
        reference: ref,
        status: row.status,
        receipt: row.mno_receipt,
        amountCents: Number(row.amount_cents),
      });
    }
  }

  // -------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------

  /**
   * Sweeps transactions stuck in `processing`. Callbacks are lost often
   * enough on Tanzanian networks that this job, not the webhook, is what
   * keeps the ledger honest. Run every 60 seconds.
   */
  async reconcilePending(): Promise<void> {
    const rows = await this.db.query(
      `SELECT external_reference, aggregator, attempt_count
         FROM transactions
        WHERE status = 'processing'
          AND initiated_at < now() - interval '3 minutes'
          AND initiated_at > now() - interval '24 hours'
        ORDER BY initiated_at
        LIMIT 200`,
    );

    for (const row of rows) {
      try {
        const result = await this.provider(row.aggregator).queryStatus(row.external_reference);
        if (result.status === 'pending') {
          // Give up after ~30 minutes of pending; the customer has moved on.
          await this.db.query(
            `UPDATE transactions
                SET attempt_count = attempt_count + 1,
                    status = CASE WHEN initiated_at < now() - interval '30 minutes'
                                  THEN 'timeout'::txn_status ELSE status END
              WHERE external_reference = $1`,
            [row.external_reference],
          );
          continue;
        }

        // Re-enter the same idempotent path the webhook uses, so there is
        // exactly one place where a payment is applied.
        await this.redis.del(`webhook:seen:${row.external_reference}`);
        await this.applyResolvedStatus(row.external_reference, result.status, result.mnoReceipt);
      } catch (err) {
        this.logger.warn(
          `reconcile failed ref=${row.external_reference}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async applyResolvedStatus(
    reference: string,
    status: 'success' | 'failed',
    receipt?: string,
  ): Promise<void> {
    const synthetic = Buffer.from(
      JSON.stringify({
        source: 'reconciliation',
        externalReference: reference,
        status,
        reference: receipt,
      }),
    );
    // Bypasses signature checks by construction — this path is only reachable
    // from our own polling of the aggregator's status endpoint.
    const guard = await this.redis.set(`webhook:seen:${reference}`, '1', 'EX', 86_400, 'NX');
    if (guard !== 'OK') return;

    await this.db.query(
      `UPDATE transactions
          SET status = $2,
              mno_receipt = COALESCE($3, mno_receipt),
              settled_at = CASE WHEN $2 = 'success' THEN now() ELSE settled_at END,
              callback_payload = $4
        WHERE external_reference = $1 AND status NOT IN ('success', 'reversed')`,
      [reference, status, receipt ?? null, synthetic.toString('utf8')],
    );

    if (status === 'success') {
      await this.db.query(
        `UPDATE rides r SET is_paid = TRUE
           FROM transactions t
          WHERE t.external_reference = $1 AND r.id = t.ride_id`,
        [reference],
      );
    }
  }

  async publicStatus(userId: string, reference: string) {
    const [row] = await this.db.query(
      `SELECT status, amount_cents, mno_receipt, provider, created_at
         FROM transactions WHERE external_reference = $1 AND user_id = $2`,
      [reference, userId],
    );
    if (!row) throw new NotFoundException('transaction not found');
    return {
      status: row.status,
      amountCents: Number(row.amount_cents),
      receipt: row.mno_receipt,
      provider: row.provider,
      createdAt: row.created_at,
    };
  }
}
