/**
 * Health endpoints.
 *
 * `/health` is the liveness probe Railway hits — it must stay cheap and must
 * NOT check dependencies, or a brief Redis blip triggers a restart loop that
 * makes the outage worse. `/health/ready` is the deep check for dashboards.
 */

import { Controller, Get, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { REDIS } from '../common/redis.module';

@Controller()
export class HealthController {
  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('health')
  liveness() {
    return { status: 'ok', service: 'kwema-ride', at: new Date().toISOString() };
  }

  @Get('healthz')
  alias() {
    return this.liveness();
  }

  // No 'api/' prefix here: the global prefix in main.ts already adds it, and
  // only /health and /healthz are excluded from it. Writing it out produced
  // /api/api/health/ready.
  @Get('health/ready')
  async readiness() {
    const checks: Record<string, string> = {};

    try {
      await this.db.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = `fail: ${(err as Error).message}`;
    }

    try {
      await this.redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = `fail: ${(err as Error).message}`;
    }

    try {
      const [row] = await this.db.query('SELECT PostGIS_Version() AS v');
      checks.postgis = row?.v ? `ok (${row.v})` : 'missing';
    } catch {
      checks.postgis = 'missing';
    }

    const healthy = Object.values(checks).every((v) => v.startsWith('ok'));
    return { status: healthy ? 'ready' : 'degraded', checks };
  }
}
