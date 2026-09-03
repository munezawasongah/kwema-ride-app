import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { AuthModule } from '../auth/auth.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { AzamPayProvider, SelcomProvider } from './mobile-money.providers';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    HttpModule.register({ timeout: 20_000, maxRedirects: 0 }),
    forwardRef(() => RealtimeModule),
    AuthModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, AzamPayProvider, SelcomProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
