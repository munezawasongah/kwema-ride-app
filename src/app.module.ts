import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { RedisModule } from './common/redis.module';
import { AuthModule } from './auth/auth.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PricingModule } from './pricing/pricing.module';
import { RidesModule } from './rides/rides.module';
import { PaymentsModule } from './payments/payments.module';
import { HealthController } from './health/health.controller';
import { JobsService } from './common/jobs.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      // Railway's Postgres plugin injects DATABASE_URL.
      url: process.env.DATABASE_URL,
      // Managed Postgres terminates TLS with its own CA; rejectUnauthorized
      // would fail the handshake against Railway's internal certificate.
      ssl:
        process.env.DATABASE_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
      // Migrations are plain SQL run by db/migrate.ts, not by TypeORM.
      // Synchronize would silently rewrite a PostGIS schema it does not model.
      synchronize: false,
      autoLoadEntities: false,
      entities: [],
      extra: {
        max: Number(process.env.DB_POOL_MAX ?? 20),
        // A dispatch query that has not answered in 8s is already useless.
        statement_timeout: 8000,
      },
    }),

    RedisModule,
    ScheduleModule.forRoot(),

    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 120 },
      // Anything that costs money or sends an SMS gets the strict bucket.
      { name: 'strict', ttl: 60_000, limit: 5 },
    ]),

    AuthModule,
    DispatchModule,
    PricingModule,
    RidesModule,
    RealtimeModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    JobsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
