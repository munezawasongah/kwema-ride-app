/**
 * Bearer token guard.
 *
 * Beyond signature verification it checks the token's `jti` against a Redis
 * denylist, so a logout, a ban, or a compromised device takes effect
 * immediately rather than at the next 15-minute expiry.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import type { Request } from 'express';

import { REDIS } from '../common/redis.module';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }

    try {
      const payload = await this.jwt.verifyAsync(header.slice(7), {
        secret: process.env.JWT_ACCESS_SECRET,
      });

      if (payload.jti && (await this.redis.sismember('jwt:denylist', payload.jti))) {
        throw new UnauthorizedException('token revoked');
      }

      request.user = {
        id: payload.sub,
        phone: payload.phone,
        role: payload.role,
        driverId: payload.driverId,
      };
      return true;
    } catch {
      throw new UnauthorizedException('invalid token');
    }
  }
}
