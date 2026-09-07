import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { RidesService } from './rides.service';

class RateDto {
  @IsInt() @Min(1) @Max(5) stars: number;
  @IsOptional() @IsString() comment?: string;
}

class CancelDto {
  @IsOptional() @IsString() reason?: string;
}

class PointDto {
  @IsNumber() lat: number;
  @IsNumber() lng: number;
  @IsOptional() @IsString() address?: string;
}

class RequestRideDto {
  @IsString() clientGeneratedId: string;
  @IsString() quoteId: string;
  @IsIn(['boda', 'bajaji', 'standard', 'xl', 'express']) category: string;
  @IsIn(['cash', 'mobile_money', 'card', 'wallet']) paymentMethod: string;
  @ValidateNested() @Type(() => PointDto) pickup: PointDto;
  @ValidateNested() @Type(() => PointDto) dropoff: PointDto;
}

/**
 * HTTP surface for rides. The live path is the WebSocket gateway; these
 * endpoints exist for history, deep links, and as a fallback when a socket
 * cannot be established at all.
 */
@Controller('rides')
@UseGuards(JwtAuthGuard)
export class RidesController {
  constructor(private readonly rides: RidesService) {}

  /**
   * Requests a ride over HTTP.
   *
   * The mobile apps do this over the WebSocket, but the web client needs an
   * HTTP path — a browser tab can lose its socket to a background-tab
   * throttle at exactly the wrong moment. Same idempotency key, same locked
   * quote, same dispatch loop; only the transport differs.
   */
  @Post('request')
  async request(@CurrentUser() user: AuthedUser, @Body() dto: RequestRideDto) {
    const ride = await this.rides.createOrGet(user.id, dto);
    // Dispatch runs out of band; progress reaches the client over the socket.
    void this.rides.startDispatch(ride.id);
    return this.rides.toWireSummary(ride);
  }

  @Get('active')
  active(@CurrentUser() user: AuthedUser) {
    return this.rides.findActiveForUser(user.id);
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthedUser,
    @Query('limit') limit = '20',
    @Query('offset') offset = '0',
  ) {
    return this.rides.history(user.id, Number(limit), Number(offset));
  }

  /**
   * Rate the other party, one to five stars.
   *
   * Either side may call it; the server works out who is rating whom from
   * the ride, so a rider cannot rate themselves and a driver cannot inflate
   * their own score.
   */
  @Post(':id/rate')
  rate(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: RateDto,
  ) {
    return this.rides.rate(id, user.id, dto.stars, dto.comment);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: CancelDto,
  ) {
    return this.rides.cancel(id, user.id, dto.reason);
  }
}
