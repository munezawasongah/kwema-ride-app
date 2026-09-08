import {
  Body, Controller, ForbiddenException, Get, Post, Query, UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { EarningsService, Period } from './earnings.service';

class PayoutDto {
  @IsString() driverId: string;
  @IsInt() @Min(1) amountCents: number;
  @IsOptional() @IsString() periodStart?: string;
  @IsOptional() @IsString() periodEnd?: string;
  @IsOptional() @IsString() notes?: string;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  // -------------------------------------------------------------------
  // Driver's own figures
  // -------------------------------------------------------------------

  /**
   * Summary for a period. Defaults to today, which is the question a driver
   * actually asks — "what have I made so far".
   */
  @Get('drivers/me/earnings')
  summary(
    @CurrentUser() user: AuthedUser,
    @Query('period') period: Period = 'today',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!user.driverId) throw new ForbiddenException('drivers only');
    return this.earnings.summary(user.driverId, period, from, to);
  }

  /** Day-by-day, for the earnings chart. */
  @Get('drivers/me/earnings/daily')
  daily(@CurrentUser() user: AuthedUser, @Query('days') days = '14') {
    if (!user.driverId) throw new ForbiddenException('drivers only');
    return this.earnings.daily(user.driverId, Math.min(Number(days) || 14, 90));
  }

  /**
   * Per-trip statement. A driver disputing their pay needs to see the trips,
   * not a total — this is what ends the argument.
   */
  @Get('drivers/me/statement')
  statement(
    @CurrentUser() user: AuthedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!user.driverId) throw new ForbiddenException('drivers only');
    return this.earnings.statement(user.driverId, from, to);
  }

  // -------------------------------------------------------------------
  // Finance
  //
  // Admin only. These expose every driver's balance and can move money, so
  // the role check is not optional.
  // -------------------------------------------------------------------

  @Get('admin/payouts')
  payouts(@CurrentUser() user: AuthedUser, @Query('minimum') minimum = '500000') {
    this.assertAdmin(user);
    return this.earnings.payoutRun(Number(minimum) || 500_000);
  }

  @Get('admin/debtors')
  debtors(@CurrentUser() user: AuthedUser) {
    this.assertAdmin(user);
    return this.earnings.debtorRun();
  }

  @Post('admin/payouts')
  recordPayout(@CurrentUser() user: AuthedUser, @Body() dto: PayoutDto) {
    this.assertAdmin(user);
    return this.earnings.recordPayout(dto.driverId, dto.amountCents, user.id, {
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      notes: dto.notes,
    });
  }

  /**
   * Rides versus money collected. Run this before every payout: a non-zero
   * variance means a trip completed without its payment being accounted for,
   * and paying out on top of that compounds the error.
   */
  @Get('admin/reconcile')
  reconcile(
    @CurrentUser() user: AuthedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    this.assertAdmin(user);
    return this.earnings.reconcile(from, to);
  }

  private assertAdmin(user: AuthedUser): void {
    if (user.role !== 'admin') throw new ForbiddenException('admin only');
  }
}
