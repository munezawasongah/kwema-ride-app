import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RidesService } from './rides.service';
import { RidesController } from './rides.controller';
import { DispatchModule } from '../dispatch/dispatch.module';
import { PricingModule } from '../pricing/pricing.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [AuthModule, DispatchModule, PricingModule, forwardRef(() => RealtimeModule)],
  controllers: [RidesController],
  providers: [RidesService],
  exports: [RidesService],
})
export class RidesModule {}
