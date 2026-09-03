import { Module, forwardRef } from '@nestjs/common';

import { RealtimeGateway } from './realtime.gateway';
import { DispatchModule } from '../dispatch/dispatch.module';
import { RidesModule } from '../rides/rides.module';
import { AuthModule } from '../auth/auth.module';
import { WsThrottleGuard } from '../common/guards/ws-throttle.guard';

@Module({
  imports: [AuthModule, DispatchModule, forwardRef(() => RidesModule)],
  providers: [RealtimeGateway, WsThrottleGuard],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
