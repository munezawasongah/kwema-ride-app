import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MapsModule } from '../maps/maps.module';
import { FareService } from './fare.service';
import { PricingController } from './pricing.controller';

@Module({
  imports: [AuthModule, MapsModule],
  controllers: [PricingController],
  providers: [FareService],
  exports: [FareService],
})
export class PricingModule {}
