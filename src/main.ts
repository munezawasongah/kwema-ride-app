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
import { ValidationPipe, Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import type { Request } from 'express';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

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

  app.setGlobalPrefix('api', { exclude: ['health', 'healthz'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Railway sends SIGTERM on redeploy. Without this, in-flight rides lose
  // their sockets without the gateway getting a chance to clean up.
  app.enableShutdownHooks();

  // Railway injects PORT. Binding to 0.0.0.0 is required inside the container.
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`Kwema Ride API listening on :${port}`);
}

void bootstrap();
