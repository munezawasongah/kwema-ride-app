import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FareService } from './fare.service';
import { VehicleCategory } from '../dispatch/dispatch.service';

class QuoteDto {
  @IsIn(['boda', 'bajaji', 'standard', 'xl', 'express'])
  category: VehicleCategory;

  @IsNumber() pickupLat: number;
  @IsNumber() pickupLng: number;
  @IsNumber() dropoffLat: number;
  @IsNumber() dropoffLng: number;

  /** Distance and duration come from the routing provider, client-side. */
  @IsNumber() distanceMetres: number;
  @IsNumber() durationSeconds: number;

  @IsOptional() @IsNumber() promoDiscountCents?: number;
}

@Controller('pricing')
@UseGuards(JwtAuthGuard)
export class PricingController {
  constructor(private readonly fares: FareService) {}

  /**
   * Returns a locked quote. The rider then requests the ride by quote id, so
   * a surge change between tapping and confirming cannot raise the price
   * they agreed to.
   */
  @Post('quote')
  quote(@Body() dto: QuoteDto) {
    return this.fares.quote({
      category: dto.category,
      distanceMetres: dto.distanceMetres,
      durationSeconds: dto.durationSeconds,
      pickup: { lat: dto.pickupLat, lng: dto.pickupLng },
      promoDiscountCents: dto.promoDiscountCents,
    });
  }
}
