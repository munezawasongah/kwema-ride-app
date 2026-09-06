/**
 * Phone + OTP authentication.
 *
 * Passwords are optional in this market — most riders will only ever use an
 * SMS code. The security properties that matter here:
 *
 *  * OTPs are stored hashed, never in plaintext, and are single-use.
 *  * Attempts are capped per phone number, so an attacker cannot brute-force
 *    a six-digit code (a million guesses at 5 tries is unreachable).
 *  * Refresh tokens are opaque, rotated on every use, and tracked in
 *    families. Presenting an already-rotated refresh token means the token
 *    was stolen, so the whole family is revoked rather than the single token.
 *  * Access tokens carry a `jti` that the guard checks against a denylist,
 *    which is what makes a ban or logout take effect immediately.
 */

import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import * as crypto from 'node:crypto';

import { REDIS } from '../common/redis.module';

const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const REFRESH_TTL_DAYS = 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // -------------------------------------------------------------------
  // OTP request
  // -------------------------------------------------------------------

  async requestOtp(phone: string): Promise<{ sent: boolean; retryAfter?: number }> {
    this.assertPhone(phone);

    // Cooldown stops both SMS cost abuse and using our gateway to spam a
    // number the attacker does not own.
    const cooldownKey = `otp:cooldown:${phone}`;
    const remaining = await this.redis.ttl(cooldownKey);
    if (remaining > 0) return { sent: false, retryAfter: remaining };

    const code = crypto.randomInt(100_000, 999_999).toString();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = this.hashOtp(code, salt);

    await this.redis
      .multi()
      .hset(`otp:${phone}`, { hash, salt, attempts: '0' })
      .expire(`otp:${phone}`, OTP_TTL_SECONDS)
      .set(cooldownKey, '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS)
      .exec();

    await this.sendSms(phone, code);
    return { sent: true };
  }

  // -------------------------------------------------------------------
  // OTP verification
  // -------------------------------------------------------------------

  async verifyOtp(
    phone: string,
    code: string,
    deviceId: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; phone: string; fullName: string; language: string; isDriver: boolean };
  }> {
    this.assertPhone(phone);

    const record = await this.redis.hgetall(`otp:${phone}`);
    if (!record?.hash) throw new UnauthorizedException('otp_expired');

    const attempts = Number.parseInt(record.attempts ?? '0', 10);
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await this.redis.del(`otp:${phone}`);
      throw new UnauthorizedException('otp_locked');
    }

    const candidate = this.hashOtp(code, record.salt);
    const matches =
      candidate.length === record.hash.length &&
      crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(record.hash));

    if (!matches) {
      await this.redis.hincrby(`otp:${phone}`, 'attempts', 1);
      throw new UnauthorizedException('otp_invalid');
    }

    // Single use: burn it before issuing anything.
    await this.redis.del(`otp:${phone}`);

    const user = await this.findOrCreateUser(phone);
    const tokens = await this.issueTokens(user, deviceId);

    return {
      ...tokens,
      user: {
        id: user.id,
        phone: user.phone,
        fullName: user.full_name,
        language: user.preferred_language,
        isDriver: Boolean(user.driver_id),
      },
    };
  }

  // -------------------------------------------------------------------
  // Refresh with rotation
  // -------------------------------------------------------------------

  async refresh(refreshToken: string, deviceId: string) {
    const tokenHash = this.sha256(refreshToken);
    const key = `refresh:${tokenHash}`;
    const stored = await this.redis.hgetall(key);

    if (!stored?.userId) {
      // Unknown or already-rotated token. If we recognise the family, this is
      // a replay of a stolen token — kill every session in that family.
      const family = await this.redis.get(`refresh:used:${tokenHash}`);
      if (family) {
        this.logger.warn(`refresh token reuse detected, revoking family ${family}`);
        await this.revokeFamily(family);
      }
      throw new UnauthorizedException('invalid_refresh_token');
    }

    // Binding to the device makes a token lifted from one handset useless on
    // another without also cloning the device id.
    if (stored.deviceId !== deviceId) {
      await this.revokeFamily(stored.family);
      throw new UnauthorizedException('device_mismatch');
    }

    const [user] = await this.db.query(
      `SELECT u.*, d.id AS driver_id FROM users u
         LEFT JOIN drivers d ON d.user_id = u.id
        WHERE u.id = $1 AND u.status = 'active'`,
      [stored.userId],
    );
    if (!user) throw new UnauthorizedException('account_unavailable');

    // Rotate: the old token is consumed and remembered as "used" so a replay
    // is detectable rather than merely rejected.
    await this.redis
      .multi()
      .del(key)
      .set(`refresh:used:${tokenHash}`, stored.family, 'EX', REFRESH_TTL_DAYS * 86_400)
      .exec();

    return this.issueTokens(user, deviceId, stored.family);
  }

  async logout(accessJti: string, refreshToken?: string): Promise<void> {
    // Denylist entry outlives the access token's own 15-minute lifetime by a
    // margin, then expires on its own.
    await this.redis.sadd('jwt:denylist', accessJti);
    await this.redis.expire('jwt:denylist', 3600);

    if (refreshToken) {
      const hash = this.sha256(refreshToken);
      const stored = await this.redis.hget(`refresh:${hash}`, 'family');
      await this.redis.del(`refresh:${hash}`);
      if (stored) await this.revokeFamily(stored);
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async issueTokens(user: any, deviceId: string, family?: string) {
    const jti = crypto.randomUUID();
    const tokenFamily = family ?? crypto.randomUUID();

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        phone: user.phone,
        role: user.driver_id ? 'driver' : 'rider',
        driverId: user.driver_id ?? undefined,
        category: user.vehicle_category ?? undefined,
        jti,
      },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
    );

    // Opaque, not a JWT: a refresh token carries no claims and is worthless
    // without the server-side record.
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    await this.redis
      .multi()
      .hset(`refresh:${this.sha256(refreshToken)}`, {
        userId: user.id,
        deviceId,
        family: tokenFamily,
        issuedAt: Date.now().toString(),
      })
      .expire(`refresh:${this.sha256(refreshToken)}`, REFRESH_TTL_DAYS * 86_400)
      .sadd(`refresh:family:${tokenFamily}`, this.sha256(refreshToken))
      .expire(`refresh:family:${tokenFamily}`, REFRESH_TTL_DAYS * 86_400)
      .exec();

    return { accessToken, refreshToken };
  }

  private async revokeFamily(family: string): Promise<void> {
    const members = await this.redis.smembers(`refresh:family:${family}`);
    if (members.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const hash of members) pipeline.del(`refresh:${hash}`);
    pipeline.del(`refresh:family:${family}`);
    await pipeline.exec();
  }

  private async findOrCreateUser(phone: string) {
    const [existing] = await this.db.query(
      `SELECT u.*, d.id AS driver_id FROM users u
         LEFT JOIN drivers d ON d.user_id = u.id
        WHERE u.phone = $1 AND u.deleted_at IS NULL`,
      [phone],
    );

    if (existing) {
      if (existing.status === 'banned' || existing.status === 'suspended') {
        throw new UnauthorizedException('account_suspended');
      }
      await this.db.query(
        `UPDATE users SET last_seen_at = now(),
                phone_verified_at = COALESCE(phone_verified_at, now()),
                status = CASE WHEN status = 'pending' THEN 'active'::account_status ELSE status END
          WHERE id = $1`,
        [existing.id],
      );
      return existing;
    }

    const [created] = await this.db.query(
      `INSERT INTO users (phone, full_name, status, phone_verified_at, referral_code)
       VALUES ($1, $2, 'active', now(), $3)
       RETURNING *, NULL::uuid AS driver_id`,
      [phone, 'Mteja', crypto.randomBytes(4).toString('hex').toUpperCase()],
    );
    return created;
  }

  /** Salted SHA-256 is adequate for a 5-minute, single-use, rate-limited code. */
  private hashOtp(code: string, salt: string): string {
    return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  }

  private sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private assertPhone(phone: string): void {
    if (!/^\+255[0-9]{9}$/.test(phone)) {
      throw new BadRequestException('phone must be +255XXXXXXXXX');
    }
  }

  /**
   * OTP message text, in the recipient's stored language.
   *
   * Kept deliberately short. Tanzanian gateways bill per 160-character
   * segment, and the French wording is the longest of the three — if a
   * translation grows past that, the whole cohort's SMS cost doubles
   * silently. Count before editing.
   */
  private otpMessage(code: string, language: string): string {
    switch (language) {
      case 'en':
        return `Your Kwema Ride code is ${code}. Do not share it with anyone.`;
      case 'fr':
        return `Votre code Kwema Ride est ${code}. Ne le partagez avec personne.`;
      default:
        return `Msimbo wako wa Kwema Ride ni ${code}. Usimshirikishe mtu yeyote.`;
    }
  }

  /**
   * Looks up the language for a phone number that may not have an account
   * yet. A first-time user has no stored preference, so they get Swahili —
   * which is the right default for this market regardless.
   */
  private async languageForPhone(phone: string): Promise<string> {
    const [row] = await this.db.query(
      `SELECT preferred_language FROM users
        WHERE phone = $1 AND deleted_at IS NULL`,
      [phone],
    );
    return row?.preferred_language ?? 'sw';
  }

  /**
   * SMS delivery. Wired to whichever Tanzanian gateway you contract
   * (Beem, NextSMS, Africa's Talking). Sender IDs must be registered with
   * TCRA before they will deliver.
   */
  private async sendSms(phone: string, code: string): Promise<void> {
    const language = await this.languageForPhone(phone);
    const message = this.otpMessage(code, language);

    if (!process.env.SMS_API_URL) {
      // In development the code goes to the log rather than silently failing.
      this.logger.warn(`[dev] OTP for ${phone}: ${code}`);
      return;
    }

    await fetch(process.env.SMS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SMS_API_KEY}`,
      },
      body: JSON.stringify({
        source_addr: process.env.SMS_SENDER_ID ?? 'KWEMA',
        recipients: [{ recipient_id: 1, dest_addr: phone.replace('+', '') }],
        message,
      }),
    }).catch((err) => this.logger.error(`sms send failed: ${err.message}`));
  }
}
