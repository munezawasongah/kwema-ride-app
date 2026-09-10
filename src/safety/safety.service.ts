/**
 * Emergency SOS.
 *
 * Principles, in order of importance:
 *
 *   An alert is never lost. No validation failure, missing GPS fix, absent
 *   trip or database hiccup may prevent the alarm being raised. Every optional
 *   detail is genuinely optional, and the write is the last thing that can
 *   fail rather than the first.
 *
 *   Speed over completeness. The response returns as soon as the alert is
 *   recorded; notifying the emergency contact and the ops team happens after,
 *   so a slow SMS gateway cannot delay the confirmation the person is staring
 *   at.
 *
 *   112 is offered, not relied upon. Tanzania's emergency line does not
 *   connect dependably outside the main cities, so the alert also reaches
 *   Kwema operations and the person's own contact.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';

export interface SosInput {
  userId: string;
  role: 'rider' | 'driver';
  rideId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  note?: string | null;
}

/**
 * Tanzania's national emergency number. 112 routes to police and is the
 * number published by the authorities; 114 is commonly listed for ambulance.
 * Both are surfaced because coverage varies by region and carrier.
 */
export const EMERGENCY_NUMBERS = {
  primary: '112',
  ambulance: '114',
  label: 'Tanzania emergency services',
};

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Raises an alert. Returns as soon as it is on record.
   *
   * `notify` is injected by the controller so this stays free of socket
   * concerns and can be tested without a gateway.
   */
  async raise(
    input: SosInput,
    notify?: (payload: Record<string, unknown>) => void,
  ) {
    const hasPosition =
      typeof input.lat === 'number' && typeof input.lng === 'number' &&
      Number.isFinite(input.lat) && Number.isFinite(input.lng);

    let alertId: string | null = null;

    try {
      const [row] = await this.db.query(
        `INSERT INTO sos_alerts
           (user_id, ride_id, raised_by, position, accuracy_m, note)
         VALUES ($1, $2, $3::sos_source,
                 ${hasPosition
                   ? 'ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography'
                   : 'NULL'},
                 $6, $7)
         RETURNING id, created_at`,
        hasPosition
          ? [input.userId, input.rideId ?? null, input.role, input.lng, input.lat,
             input.accuracyM ?? null, input.note ?? null]
          : [input.userId, input.rideId ?? null, input.role, null, null,
             input.accuracyM ?? null, input.note ?? null],
      );
      alertId = row.id;
    } catch (err) {
      // The alarm still goes out. A database problem must not silence an
      // emergency — ops get the alert over the socket regardless, and the
      // failure is logged loudly for follow-up.
      this.logger.error(
        `SOS WRITE FAILED for user ${input.userId}: ${(err as Error).message}`,
      );
    }

    this.logger.warn(
      `SOS raised by ${input.role} ${input.userId}` +
        (input.rideId ? ` on ride ${input.rideId}` : '') +
        (hasPosition ? ` at ${input.lat},${input.lng}` : ' with no GPS fix'),
    );

    const context = await this.context(input.userId, input.rideId ?? null);

    // Push to operations immediately; everything else is best effort.
    const payload = {
      alertId,
      userId: input.userId,
      role: input.role,
      rideId: input.rideId ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      raisedAt: new Date().toISOString(),
      ...context,
    };
    try { notify?.(payload); } catch { /* never block on delivery */ }

    // A short-lived flag so the admin panel can highlight the person even if
    // it missed the socket event.
    if (alertId) {
      await this.redis
        .set(`sos:open:${alertId}`, JSON.stringify(payload), 'EX', 86_400)
        .catch(() => undefined);
    }

    void this.notifyEmergencyContact(input.userId, alertId, input.lat, input.lng);

    return {
      raised: true,
      alertId,
      emergency: EMERGENCY_NUMBERS,
      contactNotified: Boolean(context.emergencyContactPhone),
      // Told plainly, because someone in trouble should not be guessing.
      message: hasPosition
        ? 'Alert sent with your location.'
        : 'Alert sent. Your location was unavailable, so describe where you are when we call.',
    };
  }

  /** Who and what, so ops do not have to look anything up. */
  private async context(userId: string, rideId: string | null) {
    try {
      const [user] = await this.db.query(
        `SELECT full_name, phone, emergency_contact_name, emergency_contact_phone
           FROM users WHERE id = $1`,
        [userId],
      );

      let ride: any = null;
      if (rideId) {
        const [r] = await this.db.query(
          `SELECT r.reference, r.status, r.pickup_address, r.dropoff_address,
                  ru.full_name AS rider_name, ru.phone AS rider_phone,
                  du.full_name AS driver_name, du.phone AS driver_phone,
                  v.plate_number, v.make, v.model, v.colour
             FROM rides r
             JOIN users ru ON ru.id = r.rider_id
             LEFT JOIN drivers d ON d.id = r.driver_id
             LEFT JOIN users du ON du.id = d.user_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
            WHERE r.id = $1`,
          [rideId],
        );
        ride = r ?? null;
      }

      return {
        name: user?.full_name ?? null,
        phone: user?.phone ?? null,
        emergencyContactName: user?.emergency_contact_name ?? null,
        emergencyContactPhone: user?.emergency_contact_phone ?? null,
        ride: ride && {
          reference: ride.reference,
          status: ride.status,
          pickup: ride.pickup_address,
          dropoff: ride.dropoff_address,
          riderName: ride.rider_name,
          riderPhone: ride.rider_phone,
          driverName: ride.driver_name,
          driverPhone: ride.driver_phone,
          vehicle: ride.plate_number
            ? `${ride.colour ?? ''} ${ride.make ?? ''} ${ride.model ?? ''} · ${ride.plate_number}`.trim()
            : null,
        },
      };
    } catch (err) {
      this.logger.error(`SOS context lookup failed: ${(err as Error).message}`);
      return { name: null, phone: null, emergencyContactName: null,
               emergencyContactPhone: null, ride: null };
    }
  }

  /**
   * Texts the person's own emergency contact.
   *
   * Fire-and-forget: an SMS gateway that is slow or down must not delay the
   * confirmation shown to someone in trouble.
   */
  /**
   * Builds the message sent to an emergency contact.
   *
   * A Google Maps link rather than raw coordinates: the contact is a family
   * member on a phone, not an operator with a mapping tool, and a tappable
   * link is the difference between knowing roughly where and being able to
   * go there.
   */
  private emergencyText(
    name: string,
    lat?: number | null,
    lng?: number | null,
  ): string {
    const where =
      lat != null && lng != null
        ? `https://maps.google.com/?q=${lat},${lng}`
        : 'location unavailable';
    return (
      `KWEMA RIDE EMERGENCY\n\n${name || 'Your contact'} has raised an ` +
      `emergency alert.\n\nLocation: ${where}\n\n` +
      `Tanzania emergency services: 112`
    );
  }

  /**
   * Sends the alert to the contact over WhatsApp.
   *
   * WhatsApp is the messaging default in Tanzania, and unlike SMS it carries
   * a tappable map link reliably and shows delivery. It needs a WhatsApp
   * Business API provider — Meta Cloud API, or a reseller — configured
   * through WHATSAPP_API_URL and WHATSAPP_TOKEN.
   *
   * SMS remains the fallback and is always attempted, because WhatsApp
   * requires the recipient to have it installed and to have data. In an
   * emergency, sending both is worth the duplicate cost.
   */
  private async sendWhatsApp(to: string, text: string): Promise<boolean> {
    const url = process.env.WHATSAPP_API_URL;
    const token = process.env.WHATSAPP_TOKEN;
    if (!url || !token) return false;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          // WhatsApp expects the number without a leading plus.
          to: to.replace('+', ''),
          type: 'text',
          text: { preview_url: true, body: text },
        }),
      });
      if (!res.ok) {
        this.logger.error(`whatsapp send failed: ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`whatsapp send error: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * A wa.me deep link the apps and the admin panel can open directly.
   *
   * This works with no Business API credentials at all — it opens WhatsApp
   * with the message pre-filled. It requires a human to press send, so it
   * complements automatic delivery rather than replacing it, and it is what
   * lets an operator reach a contact immediately from the SOS queue.
   */
  whatsappLink(to: string, text: string): string {
    return `https://wa.me/${to.replace('+', '')}?text=${encodeURIComponent(text)}`;
  }

  private async notifyEmergencyContact(
    userId: string,
    alertId: string | null,
    lat?: number | null,
    lng?: number | null,
  ): Promise<void> {
    try {
      const [user] = await this.db.query(
        `SELECT full_name, emergency_contact_phone FROM users WHERE id = $1`,
        [userId],
      );
      const to = user?.emergency_contact_phone;
      if (!to) return;

      const text = this.emergencyText(user.full_name, lat, lng);

      // Both channels, deliberately. WhatsApp carries the map link properly
      // and is what people actually read here; SMS reaches a handset with no
      // data or no WhatsApp installed. In an emergency the duplicate cost is
      // not worth optimising away.
      const viaWhatsApp = await this.sendWhatsApp(to, text);
      if (viaWhatsApp) this.logger.log(`emergency contact reached on WhatsApp`);

      if (!process.env.SMS_API_URL) {
        this.logger.warn(`[dev] would message ${to}: ${text}`);
      } else {
        await fetch(process.env.SMS_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SMS_API_KEY}`,
          },
          body: JSON.stringify({
            source_addr: process.env.SMS_SENDER_ID ?? 'KWEMA',
            recipients: [{ recipient_id: 1, dest_addr: to.replace('+', '') }],
            message: text,
          }),
        });
      }

      if (alertId) {
        await this.db.query(
          `UPDATE sos_alerts SET contact_notified_at = now() WHERE id = $1`,
          [alertId],
        );
      }
    } catch (err) {
      this.logger.error(`emergency contact notify failed: ${(err as Error).message}`);
    }
  }

  /** The person's own emergency contact, set from the account screen. */
  async setEmergencyContact(userId: string, name: string, phone: string) {
    if (!/^\+[0-9]{9,15}$/.test(phone)) {
      throw new Error('phone must be in international format, e.g. +255XXXXXXXXX');
    }
    await this.db.query(
      `UPDATE users
          SET emergency_contact_name = $2, emergency_contact_phone = $3
        WHERE id = $1`,
      [userId, name.trim().slice(0, 120), phone],
    );
    return { saved: true };
  }

  async getEmergencyContact(userId: string) {
    const [row] = await this.db.query(
      `SELECT emergency_contact_name AS name, emergency_contact_phone AS phone,
              full_name
         FROM users WHERE id = $1`,
      [userId],
    );
    return {
      name: row?.name ?? null,
      phone: row?.phone ?? null,
      emergency: EMERGENCY_NUMBERS,
      // Lets the app offer "message my contact on WhatsApp" without needing
      // Business API credentials configured.
      whatsappTemplate: row?.phone
        ? this.whatsappLink(row.phone, this.emergencyText(row.full_name))
        : null,
    };
  }

  // -------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------

  async open(limit = 50) {
    const rows = await this.db.query(
      `SELECT s.id, s.raised_by, s.status, s.note, s.created_at,
              s.acknowledged_at, s.emergency_called, s.contact_notified_at,
              ST_Y(s.position::geometry) AS lat,
              ST_X(s.position::geometry) AS lng,
              u.full_name, u.phone,
              u.emergency_contact_name, u.emergency_contact_phone,
              r.reference AS ride_reference, r.status AS ride_status,
              r.pickup_address, r.dropoff_address
         FROM sos_alerts s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN rides r ON r.id = s.ride_id
        WHERE s.status IN ('open', 'acknowledged')
        ORDER BY s.created_at DESC
        LIMIT $1`,
      [limit],
    );

    // Precomputed so an operator can reach the contact in one click rather
    // than composing a message while someone waits.
    return rows.map((r: any) => ({
      ...r,
      contactWhatsapp: r.emergency_contact_phone
        ? this.whatsappLink(
            r.emergency_contact_phone,
            this.emergencyText(r.full_name, r.lat, r.lng),
          )
        : null,
    }));
  }

  async history(limit = 100) {
    return this.db.query(
      `SELECT s.id, s.raised_by, s.status, s.created_at, s.resolved_at,
              s.resolution, u.full_name, u.phone, r.reference AS ride_reference
         FROM sos_alerts s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN rides r ON r.id = s.ride_id
        ORDER BY s.created_at DESC
        LIMIT $1`,
      [limit],
    );
  }

  async acknowledge(alertId: string, adminId: string) {
    const [row] = await this.db.query(
      `UPDATE sos_alerts
          SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [alertId, adminId],
    );
    return { acknowledged: Boolean(row) };
  }

  async resolve(alertId: string, adminId: string, resolution: string, falseAlarm = false) {
    await this.db.query(
      `UPDATE sos_alerts
          SET status = $3::sos_status, resolved_at = now(),
              resolution = $2, acknowledged_by = COALESCE(acknowledged_by, $4)
        WHERE id = $1`,
      [alertId, resolution, falseAlarm ? 'false_alarm' : 'resolved', adminId],
    );
    await this.redis.del(`sos:open:${alertId}`).catch(() => undefined);
    return { resolved: true };
  }
}
