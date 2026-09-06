/**
 * RealtimeGateway — Socket.IO gateway for driver/rider real-time traffic.
 *
 * Connectivity design for Tanzanian networks
 *  * Transport order is `websocket` first, `polling` as fallback. Some
 *    corporate and mobile proxies in TZ still break WS upgrades; polling
 *    keeps those users working instead of showing a dead map.
 *  * Application-level heartbeat on top of Socket.IO's own ping/pong. On a
 *    3G handover the socket often stays "open" while packets are being
 *    dropped, so we track last-heard-from per socket and reap silently
 *    dead peers ourselves.
 *  * Every client→server event carries a `seq` and a device timestamp so we
 *    can drop out-of-order pings replayed from an offline buffer.
 *  * Payloads use short keys and integer-encoded coordinates. At 1 ping per
 *    4 seconds per driver, trimming 60 bytes per message is real money on a
 *    bundle-priced network.
 *
 * Horizontal scaling: the Redis adapter lets any node emit to a room owned
 * by another node, so ride rooms survive a rolling deploy.
 */

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Logger, UseGuards, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';

import { DispatchService, VehicleCategory } from '../dispatch/dispatch.service';
import { RidesService } from '../rides/rides.service';
import { WsThrottleGuard } from '../common/guards/ws-throttle.guard';
import { REDIS } from '../common/redis.module';

// ---------------------------------------------------------------------
// Wire contracts
// ---------------------------------------------------------------------

interface AuthedSocket extends Socket {
  data: {
    userId: string;
    driverId?: string;
    category?: VehicleCategory;
    role: 'rider' | 'driver' | 'admin';
    lastHeardAt: number;
    lastSeq: number;
    /** Rides this socket is authorised to receive events for. */
    rooms: Set<string>;
  };
}

/** Compact location ping. Keys are terse on purpose. */
interface LocationPing {
  /** latitude  ×1e6, integer */ la: number;
  /** longitude ×1e6, integer */ ln: number;
  /** heading degrees          */ h?: number;
  /** speed km/h               */ s?: number;
  /** accuracy metres          */ a?: number;
  /** device epoch ms          */ t: number;
  /** monotonic sequence no.   */ q: number;
  /** active ride id, if any   */ r?: string;
  /** true if replayed from the device's offline buffer */ b?: boolean;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const CLIENT_TIMEOUT_MS = 60_000;
/** Coordinates are transmitted as integers scaled by this factor (~0.1 m). */
const COORD_SCALE = 1e6;

@WebSocketGateway({
  namespace: '/rt',
  transports: ['websocket', 'polling'],
  // Generous on purpose: a 3G handover can stall a connection for ~20s.
  pingInterval: 25_000,
  pingTimeout: 30_000,
  // Cuts bandwidth on the location stream by roughly half.
  perMessageDeflate: { threshold: 256 },
  maxHttpBufferSize: 64 * 1024,
  cors: { origin: process.env.WS_ALLOWED_ORIGINS?.split(',') ?? false },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly jwt: JwtService,
    private readonly dispatch: DispatchService,
    @Inject(forwardRef(() => RidesService))
    private readonly rides: RidesService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // =====================================================================
  // Lifecycle
  // =====================================================================

  afterInit(server: Server): void {
    // The Redis adapter is installed in main.ts via RedisIoAdapter. It cannot
    // be set here: this gateway declares a namespace, so `server` is a
    // Socket.IO Namespace whose `adapter` is a property, not a method.

    // Authenticate during the handshake so an unauthenticated socket never
    // reaches a message handler.
    server.use(async (socket: Socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ??
          socket.handshake.headers.authorization?.replace(/^Bearer /, '');
        if (!token) throw new Error('missing token');

        const payload = await this.jwt.verifyAsync(token, {
          secret: process.env.JWT_ACCESS_SECRET,
        });

        // Reject tokens revoked since issue (logout, ban, device change).
        if (await this.redis.sismember('jwt:denylist', payload.jti)) {
          throw new Error('revoked token');
        }

        const s = socket as AuthedSocket;
        s.data = {
          userId: payload.sub,
          driverId: payload.driverId,
          category: payload.category,
          role: payload.role,
          lastHeardAt: Date.now(),
          lastSeq: 0,
          rooms: new Set(),
        };
        next();
      } catch (err) {
        this.logger.warn(`ws auth rejected: ${(err as Error).message}`);
        next(new Error('unauthorized'));
      }
    });

    this.heartbeatTimer = setInterval(() => this.reapStaleSockets(), HEARTBEAT_INTERVAL_MS);
  }

  async handleConnection(socket: AuthedSocket): Promise<void> {
    const { userId, driverId, role } = socket.data;

    // Personal room: lets us push to a user across all their devices.
    await socket.join(`user:${userId}`);

    // Re-join the rooms for any ride still in flight. This is what makes a
    // reconnect after a tunnel or a dropped call seamless — the client does
    // not have to re-subscribe, and it immediately gets a state snapshot.
    const activeRides = await this.rides.findActiveForUser(userId);
    for (const ride of activeRides) {
      await socket.join(`ride:${ride.id}`);
      socket.data.rooms.add(`ride:${ride.id}`);
    }

    // Snapshot-on-connect: the client renders from this instead of guessing.
    socket.emit('session:ready', {
      serverTime: Date.now(),
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      activeRides: activeRides.map((r) => this.rides.toWireSummary(r)),
    });

    if (role === 'driver' && driverId) {
      await this.redis.hset(`driver:${driverId}`, 'socketId', socket.id);
    }

    this.logger.debug(`connected user=${userId} role=${role} socket=${socket.id}`);
  }

  async handleDisconnect(socket: AuthedSocket): Promise<void> {
    const { driverId, category, userId } = socket.data ?? {};
    if (!userId) return;

    if (driverId && category) {
      // Grace period rather than an immediate removal: a driver crossing a
      // cell boundary reconnects within seconds, and yanking them out of the
      // pool would cost them the trip they were about to be offered.
      await this.redis.set(`driver:reaping:${driverId}`, category, 'EX', 45);
    }
    this.logger.debug(`disconnected user=${userId} socket=${socket.id}`);
  }

  // =====================================================================
  // driver:location_update
  // =====================================================================

  @UseGuards(WsThrottleGuard) // 20 msg / 10s per socket
  @SubscribeMessage('driver:location_update')
  async onLocationUpdate(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() ping: LocationPing,
  ): Promise<{ ok: true; q: number } | { ok: false; reason: string }> {
    const { driverId, category } = socket.data;
    if (!driverId || !category) throw new WsException('not a driver session');

    socket.data.lastHeardAt = Date.now();

    // Drop replays and out-of-order deliveries. When a device drains its
    // offline buffer it may send seq 41..58 while the live stream is at 60;
    // those are still worth persisting for the trip trace, but they must not
    // overwrite the driver's *current* position.
    const isStale = ping.q <= socket.data.lastSeq;
    if (!isStale) socket.data.lastSeq = ping.q;

    const lat = ping.la / COORD_SCALE;
    const lng = ping.ln / COORD_SCALE;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false, reason: 'invalid_coordinates' };
    }

    // Reject junk fixes rather than snapping a rider's map to a random point.
    if ((ping.a ?? 0) > 200) return { ok: false, reason: 'accuracy_too_low' };

    if (!isStale) {
      await this.dispatch.upsertDriverPosition(driverId, category, lat, lng);
      await this.redis.hset(`driver:${driverId}`, {
        lat: lat.toString(),
        lng: lng.toString(),
        heading: (ping.h ?? 0).toString(),
        speed: (ping.s ?? 0).toString(),
        lastPingAt: Date.now().toString(),
      });
      await this.redis.del(`driver:reaping:${driverId}`);
    }

    // Persisted asynchronously through a queue: the breadcrumb table must
    // never be in the path of a location ack.
    await this.rides.enqueueBreadcrumb({
      driverId,
      rideId: ping.r ?? null,
      lat,
      lng,
      headingDeg: ping.h ?? null,
      speedKph: ping.s ?? null,
      accuracyM: ping.a ?? null,
      recordedAt: new Date(ping.t),
      isBackfilled: ping.b === true,
    });

    // Only the rider on this trip sees the driver move.
    if (ping.r && !isStale) {
      socket.to(`ride:${ping.r}`).emit('ride:driver_moved', {
        la: ping.la,
        ln: ping.ln,
        h: ping.h,
        s: ping.s,
        t: ping.t,
      });
    }

    // The ack doubles as the client's round-trip and clock-skew probe.
    return { ok: true, q: ping.q };
  }

  // =====================================================================
  // ride:request  (rider → server)
  // =====================================================================

  @UseGuards(WsThrottleGuard)
  @SubscribeMessage('ride:request')
  async onRideRequest(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody()
    body: {
      clientGeneratedId: string;
      category: VehicleCategory;
      pickup: { lat: number; lng: number; address?: string };
      dropoff: { lat: number; lng: number; address?: string };
      paymentMethod: 'cash' | 'mobile_money' | 'card' | 'wallet';
      quoteId: string;
    },
  ) {
    const riderId = socket.data.userId;

    // Idempotent: a retry after a dropped ack returns the same ride rather
    // than creating a second one. This matters a lot on 3G.
    const ride = await this.rides.createOrGet(riderId, body);

    await socket.join(`ride:${ride.id}`);
    socket.data.rooms.add(`ride:${ride.id}`);
    socket.emit('ride:status_change', this.rides.toWireSummary(ride));

    // Dispatch runs out-of-band; the rider gets progress via ride:status_change.
    void this.rides.startDispatch(ride.id).catch((err) => {
      this.logger.error(`dispatch failed ride=${ride.id}: ${err.message}`);
      this.server.to(`ride:${ride.id}`).emit('ride:status_change', {
        rideId: ride.id,
        status: 'failed',
        reasonCode: 'dispatch_error',
      });
    });

    return { ok: true, rideId: ride.id, reference: ride.reference };
  }

  // =====================================================================
  // ride:accept  (driver → server)
  // =====================================================================

  @SubscribeMessage('ride:accept')
  async onRideAccept(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { rideId: string; offerToken: string },
  ) {
    const { driverId } = socket.data;
    if (!driverId) throw new WsException('not a driver session');

    // The offer token is a short-lived HMAC issued with the offer. It stops a
    // driver from accepting a ride they were never offered by replaying an id.
    const claimed = await this.rides.claim(body.rideId, driverId, body.offerToken);
    if (!claimed) {
      // Almost always a benign race: another driver won a second earlier.
      socket.emit('ride:offer_closed', { rideId: body.rideId, reason: 'taken' });
      return { ok: false, reason: 'taken' };
    }

    await socket.join(`ride:${body.rideId}`);
    socket.data.rooms.add(`ride:${body.rideId}`);

    // Everyone on the trip gets the same payload from the same source of truth.
    this.server.to(`ride:${body.rideId}`).emit('ride:status_change', {
      rideId: body.rideId,
      status: 'accepted',
      driver: claimed.driverPublicProfile,
      vehicle: claimed.vehicle,
      etaSeconds: claimed.etaSeconds,
      at: Date.now(),
    });

    return { ok: true };
  }

  @SubscribeMessage('ride:decline')
  async onRideDecline(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { rideId: string; reason?: string },
  ) {
    const { driverId } = socket.data;
    if (!driverId) throw new WsException('not a driver session');
    await this.rides.declineOffer(body.rideId, driverId, body.reason);
    return { ok: true };
  }

  // =====================================================================
  // ride:status_change  (driver → server: arrived / start / complete)
  // =====================================================================

  @SubscribeMessage('ride:status_change')
  async onStatusChange(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody()
    body: { rideId: string; status: 'arrived' | 'in_progress' | 'completed'; at: number },
  ) {
    const { driverId } = socket.data;
    if (!driverId) throw new WsException('not a driver session');

    // Server-side transition validation. A driver app that replays a stale
    // 'completed' after a reconnect must not close a trip twice, and the
    // fare is computed here, never trusted from the device.
    const updated = await this.rides.transition(body.rideId, driverId, body.status, new Date(body.at));

    this.server.to(`ride:${body.rideId}`).emit('ride:status_change', this.rides.toWireSummary(updated));

    if (body.status === 'completed') {
      this.server.to(`ride:${body.rideId}`).emit('ride:fare_ready', {
        rideId: updated.id,
        fareCents: updated.finalFareCents,
        distanceM: updated.actualDistanceM,
        durationS: updated.actualDurationS,
        paymentMethod: updated.paymentMethod,
      });
    }

    return { ok: true };
  }

  // =====================================================================
  // Heartbeat
  // =====================================================================

  /**
   * Client sends `hb` every HEARTBEAT_INTERVAL_MS. The reply carries server
   * time so the app can correct clock skew — Android devices in the field
   * are routinely minutes off, which would otherwise corrupt trip timestamps.
   */
  @SubscribeMessage('hb')
  onHeartbeat(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { t: number }) {
    socket.data.lastHeardAt = Date.now();
    return { t: Date.now(), yourT: body?.t ?? null };
  }

  /**
   * Socket.IO's own ping is not enough: a half-open TCP connection on a
   * mobile network can look alive for minutes. If a driver socket goes quiet
   * we drop it, which triggers the reaping grace period and eventually
   * removes them from the dispatch pool so riders stop seeing a ghost car.
   */
  private async reapStaleSockets(): Promise<void> {
    const now = Date.now();
    const sockets = await this.server.fetchSockets();

    for (const s of sockets) {
      const data = (s as unknown as AuthedSocket).data;
      if (!data?.lastHeardAt) continue;
      if (now - data.lastHeardAt > CLIENT_TIMEOUT_MS) {
        this.logger.warn(`reaping silent socket=${s.id} user=${data.userId}`);
        s.disconnect(true);
      }
    }

    // Drivers whose grace period elapsed leave the geo pool.
    const stream = this.redis.scanStream({ match: 'driver:reaping:*', count: 100 });
    for await (const keys of stream) {
      for (const key of keys as string[]) {
        const ttl = await this.redis.ttl(key);
        if (ttl > 0) continue;
        const driverId = key.split(':').pop()!;
        const category = (await this.redis.get(key)) as VehicleCategory | null;
        if (category) await this.dispatch.removeDriverFromPool(driverId, category);
        await this.redis.del(key);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }
}
