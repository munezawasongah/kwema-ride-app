import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  IsIn, IsInt, IsOptional, IsString, Length, Matches, Min,
} from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { DeliveriesService } from './deliveries.service';

class ConfirmDto {
  @Matches(/^[0-9]{4}$/, { message: 'the code is four digits' })
  code: string;

  @IsOptional() @IsString() @Length(0, 120) receivedBy?: string;
}

class FailDto {
  @IsString() @Length(3, 500) reason: string;
}

@Controller('deliveries')
@UseGuards(JwtAuthGuard)
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  /** Everything this person sent, plus anything addressed to their number. */
  @Get('mine')
  mine(@CurrentUser() user: AuthedUser) {
    return this.deliveries.forUser(user.id, user.phone);
  }

  @Get(':rideId')
  async detail(@CurrentUser() user: AuthedUser, @Param('rideId') rideId: string) {
    const row = await this.deliveries.get(rideId);
    if (!row) return null;

    // The code proves the recipient is who they say they are, so it is shown
    // to the sender only. A courier who could read it could mark anything
    // delivered.
    if (row.rider_id !== user.id) delete row.delivery_code;
    return row;
  }

  @Post(':rideId/collected')
  collected(@CurrentUser() user: AuthedUser, @Param('rideId') rideId: string) {
    return this.deliveries.markCollected(rideId, user.driverId ?? '');
  }

  @Post(':rideId/confirm')
  confirm(
    @CurrentUser() user: AuthedUser,
    @Param('rideId') rideId: string,
    @Body() dto: ConfirmDto,
  ) {
    return this.deliveries.confirmDelivery(
      rideId, user.driverId ?? '', dto.code, dto.receivedBy,
    );
  }

  @Post(':rideId/failed')
  failed(
    @CurrentUser() user: AuthedUser,
    @Param('rideId') rideId: string,
    @Body() dto: FailDto,
  ) {
    return this.deliveries.markFailed(rideId, user.driverId ?? '', dto.reason);
  }
}
