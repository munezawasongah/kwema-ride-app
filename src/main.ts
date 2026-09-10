/**
 * Kwema Ride — API bootstrap.
 *
 * The one non-obvious thing here is the rawBody capture. Mobile money
 * webhooks are signed over the exact bytes the aggregator sent; parsing JSON
 * and re-serialising it changes those bytes and every signature check fails.
 * The `verify` hook stashes the original buffer on the request before the
 * parser touches it.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import type { Request } from 'express';

import { AppModule } from './app.module';
import { validateEnvironment } from './common/env.validation';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Before anything connects: a misconfigured deploy should fail here, with
  // the variable named, rather than three layers down in a driver error.
  validateEnvironment();

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Photo uploads arrive as base64 in JSON, which inflates the payload by
  // about a third. The global 1 MB limit rejected them, so this route gets
  // its own parser — raising the limit everywhere would widen the target for
  // every other endpoint for no reason.
  app.use(
    '/api/users/me/photo',
    json({
      limit: '12mb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  app.use(
    json({
      limit: '1mb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        // Only webhook routes need this, but capturing it globally is
        // cheaper than route-scoped parsers and the payloads are small.
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.use(
    helmet({
      // The API serves JSON only; a CSP here would just be noise.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? true,
    credentials: true,
  });

  // The status page and health probes sit outside the /api prefix so the
  // root URL and Railway's healthcheck resolve without it.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: '/', method: RequestMethod.GET },
      { path: 'health', method: RequestMethod.GET },
      { path: 'status', method: RequestMethod.GET },
      { path: 'healthz', method: RequestMethod.GET },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // The Redis adapter must be attached to the root Socket.IO server before
  // any namespace is created, so it is installed here rather than in the
  // gateway's afterInit — a namespaced gateway never receives the root
  // server, only its own Namespace.
  const wsAdapter = new RedisIoAdapter(app);
  await wsAdapter.connectToRedis(process.env.REDIS_URL);
  app.useWebSocketAdapter(wsAdapter);

  // Railway sends SIGTERM on redeploy. Without this, in-flight rides lose
  // their sockets without the gateway getting a chance to clean up.
  app.enableShutdownHooks();

  // Railway injects PORT. Binding to 0.0.0.0 is required inside the container.
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`Kwema Ride API listening on :${port}`);
}

void bootstrap();
