/**
 * Per-socket rate limiting for WebSocket messages.
 *
 * A driver app looping on a GPS callback can emit hundreds of pings a second
 * and take a gateway node down. HTTP throttling does not see socket traffic,
 * so this is a separate sliding window kept in memory per node — a socket
 * lives on exactly one node, so there is no need to coordinate through Redis.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';

const WINDOW_MS = 10_000;
const MAX_EVENTS = 20;

@Injectable()
export class WsThrottleGuard implements CanActivate {
  private readonly buckets = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const socket = context.switchToWs().getClient<Socket>();
    const now = Date.now();

    const hits = (this.buckets.get(socket.id) ?? []).filter(
      (t) => now - t < WINDOW_MS,
    );

    if (hits.length >= MAX_EVENTS) {
      throw new WsException('rate_limited');
    }

    hits.push(now);
    this.buckets.set(socket.id, hits);

    // Cheap opportunistic sweep so a long-running node does not accumulate
    // buckets for sockets that disconnected hours ago.
    if (this.buckets.size > 5000) {
      for (const [id, times] of this.buckets) {
        if (times.every((t) => now - t > WINDOW_MS)) this.buckets.delete(id);
      }
    }

    return true;
  }
}
