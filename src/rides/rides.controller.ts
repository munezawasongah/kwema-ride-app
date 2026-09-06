import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { RidesService } from './rides.service';

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

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: CancelDto,
  ) {
    return this.rides.cancel(id, user.id, dto.reason);
  }
}
