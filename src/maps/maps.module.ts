import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { AuthModule } from '../auth/auth.module';
import { MapsService } from './maps.service';
import { MapsController } from './maps.controller';

@Module({
  imports: [HttpModule.register({ timeout: 8000, maxRedirects: 2 }), AuthModule],
  controllers: [MapsController],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
