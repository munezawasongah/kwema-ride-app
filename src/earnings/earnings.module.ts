import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EarningsService } from './earnings.service';
import { EarningsController } from './earnings.controller';

@Module({
  imports: [AuthModule],
  controllers: [EarningsController],
  providers: [EarningsService],
  exports: [EarningsService],
})
export class EarningsModule {}
