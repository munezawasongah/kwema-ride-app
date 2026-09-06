import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FareService } from './fare.service';
import { MapsService } from '../maps/maps.service';
import { VehicleCategory } from '../dispatch/dispatch.service';

const CATEGORIES: VehicleCategory[] = ['boda', 'bajaji', 'standard', 'xl', 'express'];

class QuoteDto {
  @IsNumber() pickupLat: number;
  @IsNumber() pickupLng: number;
  @IsNumber() dropoffLat: number;
  @IsNumber() dropoffLng: number;

  /** Omit to price every category at once for the selector carousel. */
  @IsOptional() @IsIn(CATEGORIES) category?: VehicleCategory;

  @IsOptional() @IsNumber() promoDiscountCents?: number;
}

@Controller('pricing')
@UseGuards(JwtAuthGuard)
export class PricingController {
  constructor(
    private readonly fares: FareService,
    private readonly maps: MapsService,
  ) {}

  /**
   * Returns locked quotes. The rider then requests a ride by quote id, so a
   * surge change between tapping and confirming cannot raise the agreed price.
   *
   * Distance and duration are computed here from Google Directions, never
   * accepted from the client. An earlier version took them as request
   * parameters, which meant a modified app could quote a 12 km trip as 2 km
   * and the server would honour it.
   */
  @Post('quote')
  async quote(@Body() dto: QuoteDto) {
    const pickup = { lat: dto.pickupLat, lng: dto.pickupLng };
    const dropoff = { lat: dto.dropoffLat, lng: dto.dropoffLng };

    const categories = dto.category ? [dto.category] : CATEGORIES;

    // One route per category, but boda and cars are the only two routing
    // profiles, so the cache collapses these to two billed calls at most.
    const quotes = await Promise.all(
      categories.map(async (category) => {
        const route = await this.maps.route(pickup, dropoff, category);
        const quote = await this.fares.quote({
          category,
          distanceMetres: route.distanceMetres,
          durationSeconds:
            route.durationInTrafficSeconds ?? route.durationSeconds,
          pickup,
          promoDiscountCents: dto.promoDiscountCents,
        });

        return {
          category,
          quoteId: quote.quoteId,
          expiresAt: quote.expiresAt,
          fare: quote.fare,
          distanceMetres: route.distanceMetres,
          durationSeconds:
            route.durationInTrafficSeconds ?? route.durationSeconds,
          polyline: route.polyline,
          // Surfaced so the app can show "approximate" when Maps was down
          // rather than presenting a fallback estimate as a firm price.
          isEstimate: route.isEstimate,
        };
      }),
    );

    return { quotes };
  }
}
