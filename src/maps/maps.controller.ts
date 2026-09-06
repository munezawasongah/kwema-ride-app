import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsNumber, IsOptional, IsString, Length } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { MapsService } from './maps.service';
import { VehicleCategory } from '../dispatch/dispatch.service';

class AutocompleteDto {
  @IsString() @Length(2, 120) input: string;
  @IsString() sessionToken: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsIn(['sw', 'en', 'fr']) language?: string;
}

class RouteDto {
  @IsNumber() originLat: number;
  @IsNumber() originLng: number;
  @IsNumber() destLat: number;
  @IsNumber() destLng: number;
  @IsIn(['boda', 'bajaji', 'standard', 'xl', 'express'])
  category: VehicleCategory;
}

/**
 * Maps proxy. Every route here exists so the Google key stays on the server.
 *
 * Throttled harder than the rest of the API because each call has a direct
 * cash cost — a loop in a client is a bill, not just load.
 */
@Controller('maps')
@UseGuards(JwtAuthGuard)
export class MapsController {
  constructor(private readonly maps: MapsService) {}

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('autocomplete')
  autocomplete(@Body() dto: AutocompleteDto) {
    const near =
      dto.lat !== undefined && dto.lng !== undefined
        ? { lat: dto.lat, lng: dto.lng }
        : null;
    return this.maps.autocomplete(
      dto.input,
      near,
      dto.sessionToken,
      dto.language ?? 'sw',
    );
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('place')
  placeDetails(
    @Query('placeId') placeId: string,
    @Query('sessionToken') sessionToken: string,
  ) {
    return this.maps.placeDetails(placeId, sessionToken ?? '');
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('reverse-geocode')
  reverseGeocode(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @CurrentUser() _user: AuthedUser,
    @Query('language') language = 'sw',
  ) {
    return this.maps
      .reverseGeocode({ lat: Number(lat), lng: Number(lng) }, language)
      .then((address) => ({ address }));
  }

  /**
   * Reports what each Google API actually returns. Authenticated, and it
   * never echoes the key — only whether one is set.
   */
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Get('diagnostics')
  diagnostics() {
    return this.maps.diagnostics();
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('route')
  route(@Body() dto: RouteDto) {
    return this.maps.route(
      { lat: dto.originLat, lng: dto.originLng },
      { lat: dto.destLat, lng: dto.destLng },
      dto.category,
    );
  }
}
