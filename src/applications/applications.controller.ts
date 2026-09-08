import {
  Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query,
  Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { ApplicationsService } from './applications.service';

class ApplyDto {
  @IsString() @Length(2, 120) fullName: string;

  @Matches(/^\+255[0-9]{9}$/, { message: 'phone must be +255XXXXXXXXX' })
  phone: string;

  @IsOptional() @IsString() @Length(0, 160) email?: string;
  @IsOptional() @IsString() @Length(0, 60) city?: string;
  @IsOptional() @IsIn(['boda', 'bajaji', 'standard', 'xl', 'express']) vehicleType?: string;

  @IsBoolean() consent: boolean;

  /** Honeypot. Real people leave it empty; most bots fill every field. */
  @IsOptional() @IsString() website?: string;
}

class StatusDto {
  @IsIn(['new', 'contacted', 'documents', 'approved', 'rejected', 'duplicate'])
  status: string;

  @IsOptional() @IsString() notes?: string;
}

@Controller()
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /**
   * Public driver sign-up. The only unauthenticated write on the platform, so
   * it is throttled hard and carries a honeypot — there is no CAPTCHA, and a
   * form like this attracts bots within days of going live.
   */
  // 6 per 10 minutes per IP. Deliberately looser than the payment endpoints:
  // carrier-grade NAT and shared connections in cafes and driver hubs mean
  // several genuine applicants can arrive from one address, and a limit tuned
  // purely against bots would silently reject them.
  @Throttle({ strict: { limit: 6, ttl: 600_000 } })
  @Post('drivers/apply')
  async apply(@Body() dto: ApplyDto, @Req() req: Request) {
    // Silently accept and discard honeypot hits. Returning an error tells the
    // author which field gave them away.
    if (dto.website && dto.website.length > 0) return { received: true };

    return this.applications.submit({
      fullName: dto.fullName,
      phone: dto.phone,
      email: dto.email,
      city: dto.city,
      vehicleType: dto.vehicleType,
      consent: dto.consent,
      sourceIp: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        ?? req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
  }

  // -------------------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('admin/applications')
  list(
    @CurrentUser() user: AuthedUser,
    @Query('status') status = 'new',
    @Query('limit') limit = '100',
  ) {
    this.assertAdmin(user);
    return this.applications.list(status, Number(limit) || 100);
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/applications/counts')
  counts(@CurrentUser() user: AuthedUser) {
    this.assertAdmin(user);
    return this.applications.counts();
  }

  @UseGuards(JwtAuthGuard)
  @Patch('admin/applications/:id')
  setStatus(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: StatusDto,
  ) {
    this.assertAdmin(user);
    return this.applications.setStatus(id, dto.status, user.id, dto.notes);
  }

  private assertAdmin(user: AuthedUser): void {
    if (user.role !== 'admin') throw new ForbiddenException('admin only');
  }
}
