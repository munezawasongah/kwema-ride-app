/**
 * Card payments via DPO Pay (Direct Pay Online).
 *
 * DPO is the practical choice for card acquiring in Tanzania: it settles in
 * TZS to a local bank account, supports Visa and Mastercard including locally
 * issued cards, and handles 3-D Secure. Stripe does not operate here.
 *
 * PCI scope is the whole design constraint. The card number, expiry and CVV
 * never touch this server and never touch the mobile app's own code. The flow
 * is:
 *
 *   1. We create a transaction token server-side with the amount only.
 *   2. The app opens DPO's hosted payment page in a WebView.
 *   3. The customer enters card details on DPO's page, under DPO's cert.
 *   4. 3-D Secure runs, the issuer redirects back, and we verify the token
 *      server-side before crediting anything.
 *
 * Because we never see a PAN, this stays in PCI DSS SAQ-A — the lightest
 * bracket. Accepting card fields in our own UI, even to forward them, would
 * pull the entire platform into SAQ-D and an annual audit. It is not worth it.
 *
 * The redirect result is a hint, not proof: a customer can close the WebView
 * before the redirect fires, and the redirect URL is user-controllable.
 * Nothing is credited until verifyToken confirms it with DPO directly.
 *
 * DPO's API is XML over POST. The request shapes below are the integration
 * skeleton — reconcile field names against the credentials pack you are
 * issued before going live.
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout } from 'rxjs';

export interface CardChargeRequest {
  externalReference: string;
  amountCents: number;
  rideReference: string;
  customerEmail?: string;
  customerPhone: string;
  /** Where DPO sends the customer after 3-D Secure completes. */
  redirectUrl: string;
  backUrl: string;
}

export interface CardChargeResult {
  accepted: boolean;
  /** Hosted payment page to open in a WebView. Never render our own form. */
  checkoutUrl?: string;
  transactionToken?: string;
  message?: string;
}

export interface CardVerification {
  status: 'success' | 'failed' | 'pending';
  /** Last four digits only — the maximum we are permitted to retain. */
  cardLastFour?: string;
  cardBrand?: string;
  reason?: string;
  amountCents?: number;
}

@Injectable()
export class DpoCardProvider {
  readonly name = 'dpo' as const;
  private readonly logger = new Logger(DpoCardProvider.name);

  private readonly baseUrl =
    process.env.DPO_BASE_URL ?? 'https://secure.3gdirectpay.com';
  private readonly companyToken = process.env.DPO_COMPANY_TOKEN;
  private readonly serviceType = process.env.DPO_SERVICE_TYPE;

  constructor(private readonly http: HttpService) {}

  get isConfigured(): boolean {
    return Boolean(this.companyToken && this.serviceType);
  }

  /**
   * Creates a transaction token and returns the hosted checkout URL.
   */
  async createCharge(req: CardChargeRequest): Promise<CardChargeResult> {
    if (!this.isConfigured) {
      return { accepted: false, message: 'card payments are not configured' };
    }

    const amount = (req.amountCents / 100).toFixed(2);
    // DPO expects local time in this format for the service date.
    const serviceDate = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<API3G>
  <CompanyToken>${this.companyToken}</CompanyToken>
  <Request>createToken</Request>
  <Transaction>
    <PaymentAmount>${amount}</PaymentAmount>
    <PaymentCurrency>TZS</PaymentCurrency>
    <CompanyRef>${escapeXml(req.externalReference)}</CompanyRef>
    <RedirectURL>${escapeXml(req.redirectUrl)}</RedirectURL>
    <BackURL>${escapeXml(req.backUrl)}</BackURL>
    <CompanyRefUnique>1</CompanyRefUnique>
    <PTL>15</PTL>
    <customerPhone>${escapeXml(req.customerPhone)}</customerPhone>
    ${req.customerEmail ? `<customerEmail>${escapeXml(req.customerEmail)}</customerEmail>` : ''}
  </Transaction>
  <Services>
    <Service>
      <ServiceType>${this.serviceType}</ServiceType>
      <ServiceDescription>Kwema Ride ${escapeXml(req.rideReference)}</ServiceDescription>
      <ServiceDate>${serviceDate}</ServiceDate>
    </Service>
  </Services>
</API3G>`;

    try {
      const response = await firstValueFrom(
        this.http
          .post(`${this.baseUrl}/API/v6/`, xml, {
            headers: { 'Content-Type': 'application/xml' },
          })
          .pipe(timeout(15_000)),
      );

      const body = String(response.data);
      const code = extractTag(body, 'Result');
      const token = extractTag(body, 'TransToken');

      if (code !== '000' || !token) {
        this.logger.error(
          `dpo createToken failed ref=${req.externalReference} code=${code}`,
        );
        return {
          accepted: false,
          message: extractTag(body, 'ResultExplanation') ?? 'card setup failed',
        };
      }

      return {
        accepted: true,
        transactionToken: token,
        checkoutUrl: `${this.baseUrl}/payv2.php?ID=${token}`,
      };
    } catch (err) {
      this.logger.error(`dpo createToken error: ${(err as Error).message}`);
      throw new ServiceUnavailableException('card provider unavailable');
    }
  }

  /**
   * Verifies a transaction with DPO directly.
   *
   * This is the only thing that authorises crediting a ride. The redirect
   * back from the payment page carries a token in the query string and
   * anyone can craft that URL, so the redirect is treated purely as a
   * prompt to come and ask DPO what really happened.
   */
  async verify(transactionToken: string): Promise<CardVerification> {
    if (!this.isConfigured) return { status: 'failed', reason: 'not_configured' };

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<API3G>
  <CompanyToken>${this.companyToken}</CompanyToken>
  <Request>verifyToken</Request>
  <TransactionToken>${escapeXml(transactionToken)}</TransactionToken>
</API3G>`;

    try {
      const response = await firstValueFrom(
        this.http
          .post(`${this.baseUrl}/API/v6/`, xml, {
            headers: { 'Content-Type': 'application/xml' },
          })
          .pipe(timeout(12_000)),
      );

      const body = String(response.data);
      const code = extractTag(body, 'Result');
      const amount = extractTag(body, 'TransactionAmount');

      // 000 = paid, 900 = created but not yet paid, anything else is a failure.
      const status =
        code === '000' ? 'success' : code === '900' ? 'pending' : 'failed';

      return {
        status,
        cardLastFour: extractTag(body, 'CustomerCreditCardNumber')?.slice(-4),
        cardBrand: extractTag(body, 'CardType') ?? undefined,
        amountCents: amount ? Math.round(Number(amount) * 100) : undefined,
        reason: status === 'failed'
          ? extractTag(body, 'ResultExplanation') ?? undefined
          : undefined,
      };
    } catch (err) {
      this.logger.error(`dpo verifyToken error: ${(err as Error).message}`);
      // Unknown, not failed. The reconciliation job retries rather than
      // wrongly telling a customer their successful payment did not go through.
      return { status: 'pending', reason: 'verification_unavailable' };
    }
  }
}

/** Minimal XML tag extraction — the responses are flat and small. */
function extractTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
  return match ? match[1].trim() : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
