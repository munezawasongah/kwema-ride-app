/**
 * Redis wiring.
 *
 * Three separate connections on purpose: a client in subscriber mode cannot
 * run normal commands, and the Socket.IO adapter needs a dedicated pair. One
 * shared connection would deadlock the moment the adapter subscribes.
 */

import { Global, Module, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';

export const REDIS = 'REDIS_CLIENT';
export const REDIS_PUB = 'REDIS_PUB';
export const REDIS_SUB = 'REDIS_SUB';

function buildOptions(): RedisOptions {
  return {
    // Keeps the process alive through a Railway Redis restart instead of
    // crash-looping the API.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    reconnectOnError: (err) => err.message.includes('READONLY'),
    lazyConnect: false,
  };
}

function create(url: string): Redis {
  const client = new Redis(url, buildOptions());
  const logger = new Logger('Redis');
  client.on('error', (err) => logger.error(`redis error: ${err.message}`));
  client.on('reconnecting', () => logger.warn('redis reconnecting'));
  return client;
}

const url = () => process.env.REDIS_URL ?? 'redis://localhost:6379';

@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: () => create(url()) },
    { provide: REDIS_PUB, useFactory: () => create(url()) },
    { provide: REDIS_SUB, useFactory: () => create(url()) },
  ],
  exports: [REDIS, REDIS_PUB, REDIS_SUB],
})
export class RedisModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    // Nest disposes the providers; nothing else to do here beyond the hook
    // existing so shutdown is ordered after the gateway closes its sockets.
  }
}
