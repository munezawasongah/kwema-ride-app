/**
 * Redis-backed Socket.IO adapter.
 *
 * Why this lives here and not in the gateway:
 *
 * A gateway declared with `namespace: '/rt'` receives a Socket.IO
 * *Namespace* in `afterInit`, not the root Server. On a Namespace, `adapter`
 * is a property holding the adapter instance — calling it throws
 * `server.adapter is not a function`. The Redis adapter has to be attached
 * to the root server before any namespace is created, which means at the
 * Nest WebSocket-adapter level, not inside a gateway lifecycle hook.
 *
 * Two dedicated connections: a client in subscriber mode cannot issue normal
 * commands, so the pub and sub clients must be separate from each other and
 * from the application's own Redis client.
 */

import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ServerOptions } from 'socket.io';
import Redis from 'ioredis';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private pubClient: Redis;
  private subClient: Redis;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(url: string): Promise<void> {
    const options = {
      // Never give up on a request during a Redis failover — dropping every
      // in-flight ride room is far worse than waiting out a restart.
      maxRetriesPerRequest: null as null,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    };

    this.pubClient = new Redis(url, options);
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (err) =>
      this.logger.error(`socket.io pub client: ${err.message}`),
    );
    this.subClient.on('error', (err) =>
      this.logger.error(`socket.io sub client: ${err.message}`),
    );

    await Promise.all([
      this.pubClient.status === 'ready'
        ? Promise.resolve()
        : this.pubClient.ping(),
      this.subClient.status === 'ready'
        ? Promise.resolve()
        : this.subClient.ping(),
    ]);

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    this.logger.log('socket.io Redis adapter connected');
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    // Attached to the root server, so every namespace — including /rt —
    // inherits it and rooms work across replicas.
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.pubClient?.quit(),
      this.subClient?.quit(),
    ]);
  }
}
