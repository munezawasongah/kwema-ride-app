import { Module } from '@nestjs/common';
import { DispatchService } from './dispatch.service';

@Module({
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
