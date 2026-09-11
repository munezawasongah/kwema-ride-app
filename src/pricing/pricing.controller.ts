import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FareService } from './fare.service';
import { MapsService } from '../maps/maps.service';
import { VehicleCategory } from '../dispatch/dispatch.service';

const CATEGORIES: VehicleCategory[] = ['boda', 'bajaji', 'standard', 'xl', 'express',
  'e_boda', 'e_bajaji', 'e_car'];

class QuoteDto {
  @IsNumber() pickupLat: number;
  @IsNumber() pickupLng: number;
  @IsNumber() dropoffLat: number;
  @IsNumber() dropoffLng: number;

  /** Omit to price every category at once for the selector carousel. */
  @IsOptional() @IsIn(CATEGORIES) category?: VehicleCategory;

  /** ride, parcel or food. Each has its own versioned rate card. */
  @IsOptional() @IsIn(['ride', 'parcel', 'food']) serviceType?: string;

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

    const service = (dto.serviceType ?? 'ride') as 'ride' | 'parcel' | 'food';

    // XL and express carry passengers, not goods, so they have no delivery
    // rate card. Quoting them would fail per-category with a confusing error.
    // XL and express carry passengers, not goods. Everything else can, and
    // the electric tiers are no different in what they can hold.
    const available = service === 'ride'
      ? CATEGORIES
      : ([
          'boda', 'e_boda', 'bajaji', 'e_bajaji', 'standard', 'e_car',
        ] as VehicleCategory[]);

    const categories = dto.category ? [dto.category] : available;

    // One route per category, but boda and cars are the only two routing
    // profiles, so the cache collapses these to two billed calls at most.
    const quotes = await Promise.all(
      categories.map(async (category) => {
        const route = await this.maps.route(pickup, dropoff, category);
        const quote = await this.fares.quote({
          category,
          serviceType: service,
          distanceMetres: route.distanceMetres,
          durationSeconds:
            route.durationInTrafficSeconds ?? route.durationSeconds,
          pickup,
          promoDiscountCents: dto.promoDiscountCents,
        });

        return {
          category,
          serviceType: service,
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
