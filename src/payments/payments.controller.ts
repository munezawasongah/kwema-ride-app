/**
 * PaymentsController + PaymentsService
 *
 * Flow
 *   1. Rider confirms payment → POST /payments/collect
 *      We create a `pending` transaction row *before* calling the aggregator.
 *      If the process dies mid-call, reconciliation still finds the intent.
 *   2. Aggregator pushes a USSD/STK prompt to the customer's handset.
 *   3. Customer enters their PIN. Aggregator calls our webhook.
 *   4. Webhook verifies the signature, applies the result idempotently,
 *      settles the ride, and emits over WebSocket to both apps.
 *   5. A reconciliation job sweeps anything still `processing` after 3
 *      minutes and queries the aggregator directly — callbacks do get lost.
 *
 * The webhook is the source of truth, never the HTTP response to step 1.
 * On a Tanzanian network the customer routinely takes 40+ seconds to find
 * their PIN, so the synchronous call tells you only that the push was
 * accepted.
 */

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Get,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { Mno } from './mobile-money.providers';
import { PaymentsService } from './payments.service';
import { CashService } from './cash.service';

interface CollectDto {
  rideId: string;
  mno: Mno;
  /** Optional: defaults to the account phone. Lets a rider pay from another line. */
  payerPhone?: string;
}

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly cash: CashService,
  ) {}

  // -------------------------------------------------------------------
  // Rider-initiated collection
  // -------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  // A payment prompt is disruptive; 5 attempts per minute per user is
  // already generous and stops a buggy client from spamming a handset.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('collect')
  async collect(@CurrentUser() user: { id: string; phone: string }, @Body() dto: CollectDto) {
    if (!dto.rideId || !dto.mno) throw new BadRequestException('rideId and mno are required');

    const phone = dto.payerPhone ?? user.phone;
    if (!/^\+255[0-9]{9}$/.test(phone)) {
      throw new BadRequestException('phone must be in +255XXXXXXXXX format');
    }

    return this.payments.initiateCollection(user.id, dto.rideId, dto.mno, phone);
  }

  // -------------------------------------------------------------------
  // Card
  // -------------------------------------------------------------------

  /**
   * Starts a card payment and returns a hosted checkout URL for the app to
   * open in a WebView. We never accept card fields ourselves — doing so would
   * pull the whole platform into PCI DSS SAQ-D.
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('card/initiate')
  initiateCard(
    @CurrentUser() user: { id: string; phone: string },
    @Body() dto: { rideId: string },
  ) {
    if (!dto?.rideId) throw new BadRequestException('rideId is required');
    return this.payments.initiateCardPayment(user.id, dto.rideId, user.phone);
  }

  /**
   * Called by the app once the WebView hits our redirect URL. The redirect is
   * only a prompt: the outcome is confirmed with the provider server-side.
   */
  @UseGuards(JwtAuthGuard)
  @Post('card/verify')
  verifyCard(
    @CurrentUser() user: { id: string },
    @Body() dto: { reference: string },
  ) {
    if (!dto?.reference) throw new BadRequestException('reference is required');
    return this.payments.verifyCardPayment(user.id, dto.reference);
  }

  // -------------------------------------------------------------------
  // Cash
  // -------------------------------------------------------------------

  /**
   * Driver confirms they were handed the cash. Commission is only booked
   * against their wallet at this point — never automatically on completion,
   * because a rider who leaves without paying is a real occurrence.
   */
  @UseGuards(JwtAuthGuard)
  @Post('cash/confirm')
  confirmCash(
    @CurrentUser() user: { id: string; driverId?: string },
    @Body() dto: { rideId: string },
  ) {
    if (!user.driverId) throw new ForbiddenException('drivers only');
    if (!dto?.rideId) throw new BadRequestException('rideId is required');
    return this.cash.confirmCollection(dto.rideId, user.driverId);
  }

  /** Driver's current cash-commission debt position. */
  @UseGuards(JwtAuthGuard)
  @Get('cash/balance')
  cashBalance(@CurrentUser() user: { id: string; driverId?: string }) {
    if (!user.driverId) throw new ForbiddenException('drivers only');
    return this.cash.debtStatus(user.driverId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('status/:reference')
  async status(@CurrentUser() user: { id: string }, @Param('reference') reference: string) {
    return this.payments.publicStatus(user.id, reference);
  }

  // -------------------------------------------------------------------
  // Aggregator webhooks
  //
  // Unauthenticated by JWT (the aggregator has none) but protected by:
  //   * HMAC signature over the raw body, verified per provider;
  //   * a source-IP allowlist enforced at ingress/WAF;
  //   * replay bounds on the timestamp;
  //   * idempotency on external_reference.
  // Always returns 200 once the signature is valid, even on a business
  // failure — a non-2xx makes aggregators retry for hours.
  // -------------------------------------------------------------------
  @Post('webhook/:provider')
  @HttpCode(200)
  async webhook(
    @Param('provider') providerName: 'azampay' | 'selcom',
    @Headers() headers: Record<string, string>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    // rawBody is captured by the body-parser verify hook in main.ts; the
    // parsed body cannot be used because re-serialising changes the bytes.
    if (!req.rawBody) {
      this.logger.error('rawBody missing — check bodyParser verify hook');
      return { received: true };
    }
    await this.payments.handleWebhook(providerName, headers, req.rawBody);
    return { received: true };
  }
}
