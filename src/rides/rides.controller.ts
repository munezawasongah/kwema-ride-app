import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { RidesService } from './rides.service';
import { DeliveriesService } from '../deliveries/deliveries.service';

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

class DeliveryDto {
  @IsString() @Length(2, 120) recipientName: string;
  @Matches(/^\+255[0-9]{9}$/, { message: 'recipient phone must be +255XXXXXXXXX' })
  recipientPhone: string;
  @IsOptional() @IsString() @Length(0, 500) recipientNote?: string;
  @IsString() @Length(2, 240) description: string;
  @IsOptional() @IsIn(['small', 'medium', 'large']) size?: string;
  @IsOptional() @IsInt() @Min(0) declaredValueCents?: number;
  @IsOptional() @IsIn(['sender', 'recipient']) farePaidBy?: string;
  @IsOptional() @IsInt() @Min(0) cashToCollectCents?: number;
}

class RequestRideDto {
  @IsString() clientGeneratedId: string;

  @IsOptional() @IsIn(['ride', 'parcel', 'food']) serviceType?: string;

  /** Required when serviceType is parcel or food. */
  @IsOptional() @ValidateNested() @Type(() => DeliveryDto) delivery?: DeliveryDto;
  @IsString() quoteId: string;
  @IsIn(['boda', 'bajaji', 'standard', 'xl', 'express',
  'e_boda', 'e_bajaji', 'e_car']) category: string;
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
  constructor(
    private readonly rides: RidesService,
    private readonly deliveries: DeliveriesService,
  ) {}

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
    const service = dto.serviceType ?? 'ride';

    // Validated before the ride exists: creating one and then rejecting the
    // delivery detail would leave an orphaned job occupying the rider's one
    // active slot for that service.
    if (service !== 'ride') {
      if (!dto.delivery) {
        throw new BadRequestException('delivery details are required');
      }
      this.deliveries.validate(dto.delivery as any, dto.category);
    }

    const ride = await this.rides.createOrGet(user.id, dto);

    let deliveryCode: string | undefined;
    if (service !== 'ride' && dto.delivery) {
      const attached = await this.deliveries.attach(ride.id, dto.delivery as any);
      deliveryCode = attached.deliveryCode;
    }

    // Dispatch runs out of band; progress reaches the client over the socket.
    void this.rides.startDispatch(ride.id);

    return {
      ...this.rides.toWireSummary(ride),
      serviceType: service,
      // Shown to the sender only. They pass it to the recipient, who quotes
      // it to the courier at handover.
      deliveryCode,
    };
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
