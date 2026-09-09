import {
  Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsNumber, IsOptional, IsString, Matches, Length } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SafetyService, EMERGENCY_NUMBERS } from './safety.service';

class SosDto {
  @IsOptional() @IsString() rideId?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsNumber() accuracyM?: number;
  @IsOptional() @IsString() @Length(0, 500) note?: string;
}

class ContactDto {
  @IsString() @Length(2, 120) name: string;
  @Matches(/^\+[0-9]{9,15}$/, { message: 'use international format, e.g. +255XXXXXXXXX' })
  phone: string;
}

class ResolveDto {
  @IsString() @Length(1, 1000) resolution: string;
  @IsOptional() @IsBoolean() falseAlarm?: boolean;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class SafetyController {
  constructor(
    private readonly safety: SafetyService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * Raise an emergency alert.
   *
   * Deliberately NOT rate-limited the way other write endpoints are. Somebody
   * pressing this repeatedly is in trouble, not abusing the API, and a 429
   * here would be indefensible. A generous ceiling exists only to stop a
   * looping client, and it is far above anything a person could produce.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('sos')
  async raise(@CurrentUser() user: AuthedUser, @Body() dto: SosDto) {
    return this.safety.raise(
      {
        userId: user.id,
        role: user.driverId ? 'driver' : 'rider',
        rideId: dto.rideId,
        lat: dto.lat,
        lng: dto.lng,
        accuracyM: dto.accuracyM,
        note: dto.note,
      },
      (payload) => {
        // Operations first — the admin panel lights up immediately.
        this.gateway.server.to('ops').emit('sos:raised', payload);
        // And everyone on the trip, so the other party knows help was called.
        if (dto.rideId) {
          this.gateway.server.to(`ride:${dto.rideId}`).emit('sos:raised', {
            rideId: dto.rideId,
            role: payload.role,
          });
        }
      },
    );
  }

  /** Emergency numbers and the saved contact, for the app's safety screen. */
  @Get('sos/contact')
  contact(@CurrentUser() user: AuthedUser) {
    return this.safety.getEmergencyContact(user.id);
  }

  @Post('sos/contact')
  async setContact(@CurrentUser() user: AuthedUser, @Body() dto: ContactDto) {
    return this.safety.setEmergencyContact(user.id, dto.name, dto.phone);
  }

  /** Public-ish: the numbers themselves are not secret and are worth showing. */
  @Get('sos/numbers')
  numbers() {
    return EMERGENCY_NUMBERS;
  }

  // -------------------------------------------------------------------

  @Get('admin/sos')
  openAlerts(@CurrentUser() user: AuthedUser, @Query('history') history?: string) {
    this.assertAdmin(user);
    return history === 'true' ? this.safety.history() : this.safety.open();
  }

  @Post('admin/sos/:id/acknowledge')
  acknowledge(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    this.assertAdmin(user);
    return this.safety.acknowledge(id, user.id);
  }

  @Post('admin/sos/:id/resolve')
  resolve(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: ResolveDto,
  ) {
    this.assertAdmin(user);
    return this.safety.resolve(id, user.id, dto.resolution, dto.falseAlarm ?? false);
  }

  private assertAdmin(user: AuthedUser): void {
    if (user.role !== 'admin') throw new ForbiddenException('admin only');
  }
}
