/**
 * Mobile money adapters — AzamPay and Selcom.
 *
 * Both aggregators front the same four MNO rails (Vodacom M-Pesa, Mixx by
 * Yas / Tigo Pesa, Airtel Money, HaloPesa). We keep two behind one interface
 * because in practice one of them will be degraded on any given evening, and
 * being able to fail collections over to the other is worth the extra adapter.
 *
 * IMPORTANT: endpoint paths, field names and signing details differ between
 * aggregator API versions and change without much notice. Treat the request
 * shapes below as the integration skeleton and reconcile them against the
 * sandbox contract you are issued before going live. The security properties
 * — outbound signing, inbound verification, idempotency, timeouts, no secrets
 * on the client — are the parts that must not be altered.
 */

import { Injectable, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout, retry } from 'rxjs';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';
import * as crypto from 'node:crypto';

export type Mno = 'mpesa' | 'tigopesa' | 'airtelmoney' | 'halopesa' | 'azampesa';

export interface CollectionRequest {
  /** Our unique reference; also the idempotency key. */
  externalReference: string;
  amountCents: number;
  /** E.164, +255XXXXXXXXX. */
  payerPhone: string;
  mno: Mno;
  rideReference: string;
  /** Shown on the customer's handset during the USSD prompt. */
  narration: string;
}

export interface CollectionResult {
  accepted: boolean;
  aggregatorTxnId?: string;
  /** Some rails return the MNO receipt only on the callback. */
  message?: string;
  raw: unknown;
}

export interface WebhookVerification {
  valid: boolean;
  externalReference?: string;
  status?: 'success' | 'failed' | 'pending';
  mnoReceipt?: string;
  amountCents?: number;
  reason?: string;
}

export interface MobileMoneyProvider {
  readonly name: 'azampay' | 'selcom';
  initiateCollection(req: CollectionRequest): Promise<CollectionResult>;
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): WebhookVerification;
  /** Used by the reconciliation job for transactions stuck in `processing`. */
  queryStatus(externalReference: string): Promise<WebhookVerification>;
}

// =====================================================================
// Shared helpers
// =====================================================================

/** MSISDN in the local format most TZ rails expect: 255XXXXXXXXX. */
function toLocalMsisdn(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** TZS is quoted to the aggregator in whole shillings, not cents. */
function toShillings(cents: number): number {
  return Math.round(cents / 100);
}

/** Timing-safe comparison; a plain === leaks signature bytes via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// =====================================================================
// AzamPay
// =====================================================================

@Injectable()
export class AzamPayProvider implements MobileMoneyProvider {
  readonly name = 'azampay' as const;
  private readonly logger = new Logger(AzamPayProvider.name);

  private readonly authBase = process.env.AZAMPAY_AUTH_BASE_URL!;
  private readonly checkoutBase = process.env.AZAMPAY_CHECKOUT_BASE_URL!;
  private readonly appName = process.env.AZAMPAY_APP_NAME!;
  private readonly clientId = process.env.AZAMPAY_CLIENT_ID!;
  private readonly clientSecret = process.env.AZAMPAY_CLIENT_SECRET!;
  private readonly apiKey = process.env.AZAMPAY_API_KEY!;
  private readonly webhookSecret = process.env.AZAMPAY_WEBHOOK_SECRET!;

  constructor(
    private readonly http: HttpService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Bearer tokens are cached in Redis, not in process memory: with several
   * API pods, per-process caching means N token requests per expiry and
   * aggregators do rate-limit that endpoint.
   */
  private async getAccessToken(): Promise<string> {
    const cacheKey = 'azampay:token';
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    // Single-flight: only one pod refreshes, the rest wait and read the cache.
    const lock = await this.redis.set('azampay:token:lock', '1', 'EX', 15, 'NX');
    if (lock !== 'OK') {
      await new Promise((r) => setTimeout(r, 400));
      const retryCached = await this.redis.get(cacheKey);
      if (retryCached) return retryCached;
    }

    try {
      const response = await firstValueFrom(
        this.http
          .post(
            `${this.authBase}/AppRegistration/GenerateToken`,
            {
              appName: this.appName,
              clientId: this.clientId,
              clientSecret: this.clientSecret,
            },
            { headers: { 'Content-Type': 'application/json' } },
          )
          .pipe(timeout(10_000)),
      );

      const token: string = response.data?.data?.accessToken;
      const expiresAt: string | undefined = response.data?.data?.expire;
      if (!token) throw new Error('token missing from auth response');

      // Refresh a minute early to avoid using a token mid-expiry.
      const ttl = expiresAt
        ? Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000) - 60)
        : 3_000;

      await this.redis.set(cacheKey, token, 'EX', ttl);
      return token;
    } finally {
      await this.redis.del('azampay:token:lock');
    }
  }

  async initiateCollection(req: CollectionRequest): Promise<CollectionResult> {
    const token = await this.getAccessToken();

    const payload = {
      accountNumber: toLocalMsisdn(req.payerPhone),
      amount: toShillings(req.amountCents).toString(),
      currency: 'TZS',
      externalId: req.externalReference,
      provider: this.mapProvider(req.mno),
      additionalProperties: {
        rideReference: req.rideReference,
        narration: req.narration,
      },
    };

    try {
      const response = await firstValueFrom(
        this.http
          .post(`${this.checkoutBase}/azampay/mno/checkout`, payload, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-API-Key': this.apiKey,
              'Content-Type': 'application/json',
              // Aggregator-side idempotency, on top of our own DB constraint.
              'X-Idempotency-Key': req.externalReference,
            },
          })
          // One retry only: a collection is not safely repeatable beyond the
          // idempotency key, and the customer's handset is already prompting.
          .pipe(timeout(20_000), retry({ count: 1, delay: 1_500 })),
      );

      const accepted = response.data?.success === true;
      return {
        accepted,
        aggregatorTxnId: response.data?.transactionId,
        message: response.data?.message,
        raw: response.data,
      };
    } catch (err: any) {
      this.logger.error(
        `azampay checkout failed ref=${req.externalReference}: ${err?.message}`,
      );
      // Never assume failure: the push may have reached the handset even
      // though our HTTP call timed out. The caller leaves the transaction in
      // `processing` and lets the callback or the reconciliation job decide.
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  /**
   * Callback verification.
   *
   * Two independent controls, because either alone has failed in production
   * somewhere: an HMAC over the exact raw body, and an allowlist of source
   * IPs enforced at the ingress. Never parse the body before verifying —
   * JSON round-tripping changes bytes and breaks the signature.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): WebhookVerification {
    const provided = headers['x-signature'] ?? headers['authorization'] ?? '';
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!provided || !safeEqual(provided.replace(/^sha256=/, ''), expected)) {
      this.logger.warn('azampay webhook signature mismatch');
      return { valid: false, reason: 'bad_signature' };
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    const status = String(body.transactionstatus ?? body.status ?? '').toLowerCase();

    return {
      valid: true,
      externalReference: body.utilityref ?? body.externalId,
      status: status === 'success' ? 'success' : status === 'pending' ? 'pending' : 'failed',
      mnoReceipt: body.reference ?? body.receipt,
      amountCents: body.amount ? Math.round(Number(body.amount) * 100) : undefined,
      reason: body.message,
    };
  }

  async queryStatus(externalReference: string): Promise<WebhookVerification> {
    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.http
        .get(`${this.checkoutBase}/azampay/transaction/${externalReference}`, {
          headers: { Authorization: `Bearer ${token}`, 'X-API-Key': this.apiKey },
        })
        .pipe(timeout(10_000)),
    );
    const status = String(response.data?.status ?? '').toLowerCase();
    return {
      valid: true,
      externalReference,
      status: status === 'success' ? 'success' : status === 'pending' ? 'pending' : 'failed',
      mnoReceipt: response.data?.reference,
    };
  }

  private mapProvider(mno: Mno): string {
    switch (mno) {
      case 'mpesa': return 'Mpesa';
      case 'tigopesa': return 'Tigo';
      case 'airtelmoney': return 'Airtel';
      case 'halopesa': return 'Halopesa';
      case 'azampesa': return 'Azampesa';
    }
  }
}

// =====================================================================
// Selcom
// =====================================================================

@Injectable()
export class SelcomProvider implements MobileMoneyProvider {
  readonly name = 'selcom' as const;
  private readonly logger = new Logger(SelcomProvider.name);

  private readonly baseUrl = process.env.SELCOM_BASE_URL!;
  private readonly apiKey = process.env.SELCOM_API_KEY!;
  private readonly apiSecret = process.env.SELCOM_API_SECRET!;
  private readonly vendorId = process.env.SELCOM_VENDOR_ID!;

  constructor(private readonly http: HttpService) {}

  /**
   * Selcom authenticates each request with a digest rather than a bearer
   * token: an HMAC-SHA256 over the concatenation of the signed field names
   * and their values, in a declared order. The header set below carries the
   * digest, the ordered field list, and a timestamp that bounds replay.
   */
  private buildAuthHeaders(payload: Record<string, unknown>): Record<string, string> {
    const timestamp = new Date().toISOString();
    const signedFields = Object.keys(payload);

    // The canonical string is "timestamp=<ts>&field1=value1&field2=value2..."
    // in exactly the order declared in the Signed-Fields header.
    const canonical =
      `timestamp=${timestamp}` +
      signedFields.map((f) => `&${f}=${payload[f]}`).join('');

    const digest = crypto
      .createHmac('sha256', this.apiSecret)
      .update(canonical)
      .digest('base64');

    return {
      'Content-Type': 'application/json',
      Authorization: `SELCOM ${Buffer.from(this.apiKey).toString('base64')}`,
      Digest: digest,
      'Digest-Method': 'HS256',
      'Signed-Fields': signedFields.join(','),
      Timestamp: timestamp,
    };
  }

  async initiateCollection(req: CollectionRequest): Promise<CollectionResult> {
    // Field order matters for the digest, so build it explicitly.
    const payload = {
      transid: req.externalReference,
      utilitycode: 'CASHIN',
      utilityref: req.rideReference,
      amount: toShillings(req.amountCents),
      vendor: this.vendorId,
      pin: undefined as unknown as string, // omitted for push flow
      msisdn: toLocalMsisdn(req.payerPhone),
    };
    delete (payload as Record<string, unknown>).pin;

    try {
      const response = await firstValueFrom(
        this.http
          .post(`${this.baseUrl}/v1/utilitypayment/process`, payload, {
            headers: this.buildAuthHeaders(payload),
          })
          .pipe(timeout(20_000)),
      );

      const code = String(response.data?.resultcode ?? '');
      return {
        // '000' is accepted; '111' means pending customer authorisation,
        // which is the normal outcome of a USSD push.
        accepted: code === '000' || code === '111',
        aggregatorTxnId: response.data?.reference ?? response.data?.transid,
        message: response.data?.message,
        raw: response.data,
      };
    } catch (err: any) {
      this.logger.error(`selcom collection failed ref=${req.externalReference}: ${err?.message}`);
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): WebhookVerification {
    const provided = headers['digest'] ?? '';
    const timestamp = headers['timestamp'] ?? '';

    // Bound replay: a captured callback older than five minutes is refused
    // even if its signature is valid.
    const skewMs = Math.abs(Date.now() - new Date(timestamp).getTime());
    if (!timestamp || Number.isNaN(skewMs) || skewMs > 300_000) {
      return { valid: false, reason: 'stale_timestamp' };
    }

    const expected = crypto
      .createHmac('sha256', this.apiSecret)
      .update(`timestamp=${timestamp}&${rawBody.toString('utf8')}`)
      .digest('base64');

    if (!safeEqual(provided, expected)) {
      this.logger.warn('selcom webhook digest mismatch');
      return { valid: false, reason: 'bad_signature' };
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    const code = String(body.resultcode ?? '');
    return {
      valid: true,
      externalReference: body.transid,
      status: code === '000' ? 'success' : code === '111' ? 'pending' : 'failed',
      mnoReceipt: body.reference,
      amountCents: body.amount ? Math.round(Number(body.amount) * 100) : undefined,
      reason: body.message,
    };
  }

  async queryStatus(externalReference: string): Promise<WebhookVerification> {
    const payload = { transid: externalReference };
    const response = await firstValueFrom(
      this.http
        .get(`${this.baseUrl}/v1/utilitypayment/query`, {
          params: payload,
          headers: this.buildAuthHeaders(payload),
        })
        .pipe(timeout(10_000)),
    );
    const code = String(response.data?.resultcode ?? '');
    return {
      valid: true,
      externalReference,
      status: code === '000' ? 'success' : code === '111' ? 'pending' : 'failed',
      mnoReceipt: response.data?.reference,
    };
  }
}
