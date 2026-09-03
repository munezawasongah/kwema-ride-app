import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { RidesService } from './rides.service';

class CancelDto {
  @IsOptional() @IsString() reason?: string;
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
