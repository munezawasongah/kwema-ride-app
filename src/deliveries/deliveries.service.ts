/**
 * Kwema Delivery (parcels) and Kwema Food.
 *
 * Both are courier jobs and reuse the ride machinery entirely: the same
 * dispatch, fare engine, payments, breadcrumb trail, SOS and ratings. This
 * service adds only what a delivery has that a ride does not — a recipient
 * who is not the booker, a description of the goods, and proof of handover.
 *
 * The handover proof is a four-digit code rather than a signature or a photo.
 * It works on any handset, needs no data at the doorstep, and actually proves
 * the right person received the item — a photo of a parcel on a step proves
 * only that it was put down somewhere.
 */

import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'node:crypto';

export type ServiceType = 'ride' | 'parcel' | 'food';
export type ParcelSize = 'small' | 'medium' | 'large';

export interface DeliveryDetails {
  recipientName: string;
  recipientPhone: string;
  recipientNote?: string;
  description: string;
  size?: ParcelSize;
  declaredValueCents?: number;
  farePaidBy?: 'sender' | 'recipient';
  cashToCollectCents?: number;
}

/**
 * What each tier can realistically carry. A boda cannot take a fridge, and
 * offering the option only to have the courier refuse at the door wastes
 * everyone's time.
 */
export const SIZE_LIMITS: Record<ParcelSize, string[]> = {
  small: ['boda', 'bajaji', 'standard'],
  medium: ['bajaji', 'standard'],
  large: ['standard'],
};

@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(private readonly db: DataSource) {}

  /** Four digits, generated with a CSPRNG so it cannot be guessed in order. */
  private generateCode(): string {
    return crypto.randomInt(0, 10_000).toString().padStart(4, '0');
  }

  validate(details: DeliveryDetails, category: string): void {
    const name = details.recipientName?.trim() ?? '';
    if (name.length < 2 || name.length > 120) {
      throw new BadRequestException('recipient name must be 2-120 characters');
    }
    if (!/^\+255[0-9]{9}$/.test(details.recipientPhone ?? '')) {
      throw new BadRequestException('recipient phone must be +255XXXXXXXXX');
    }
    if (!details.description?.trim()) {
      throw new BadRequestException('describe what is being sent');
    }
    if (details.description.length > 240) {
      throw new BadRequestException('description is too long');
    }

    const size = details.size ?? 'small';
    if (!SIZE_LIMITS[size]) throw new BadRequestException('invalid parcel size');
    if (!SIZE_LIMITS[size].includes(category)) {
      throw new BadRequestException(
        `a ${size} item cannot be carried by ${category}`,
      );
    }

    if ((details.cashToCollectCents ?? 0) < 0) {
      throw new BadRequestException('cash to collect cannot be negative');
    }
  }

  /** Attaches the delivery detail to a ride that has already been created. */
  async attach(rideId: string, details: DeliveryDetails) {
    const code = this.generateCode();

    await this.db.query(
      `INSERT INTO deliveries
         (ride_id, recipient_name, recipient_phone, recipient_note,
          description, size, declared_value_cents, fare_paid_by,
          cash_to_collect_cents, delivery_code)
       VALUES ($1, $2, $3, $4, $5, $6::parcel_size, $7, $8::payer, $9, $10)
       ON CONFLICT (ride_id) DO NOTHING`,
      [
        rideId,
        details.recipientName.trim(),
        details.recipientPhone,
        details.recipientNote?.trim() ?? null,
        details.description.trim(),
        details.size ?? 'small',
        details.declaredValueCents ?? null,
        details.farePaidBy ?? 'sender',
        details.cashToCollectCents ?? 0,
        code,
      ],
    );

    return { deliveryCode: code };
  }

  async get(rideId: string) {
    const [row] = await this.db.query(
      `SELECT d.*, r.service_type, r.status AS ride_status, r.reference
         FROM deliveries d JOIN rides r ON r.id = d.ride_id
        WHERE d.ride_id = $1`,
      [rideId],
    );
    return row ?? null;
  }

  /**
   * Marks the goods collected from the sender. Distinct from the ride
   * starting: a courier can be at the pickup point for a while, and the
   * sender needs to know the item is actually in hand.
   */
  async markCollected(rideId: string, driverId: string) {
    const [row] = await this.db.query(
      `UPDATE deliveries d
          SET collected_at = now()
         FROM rides r
        WHERE d.ride_id = $1 AND r.id = d.ride_id AND r.driver_id = $2
          AND d.collected_at IS NULL
        RETURNING d.ride_id`,
      [rideId, driverId],
    );
    if (!row) throw new BadRequestException('not collectable');
    return { collected: true };
  }

  /**
   * Completes the handover against the recipient's code.
   *
   * The code is compared in constant time. That is not paranoia about a
   * four-digit secret; it is that this endpoint is the one place a courier
   * could otherwise probe for a working code, and the comparison costs
   * nothing.
   */
  async confirmDelivery(
    rideId: string,
    driverId: string,
    code: string,
    receivedBy?: string,
  ) {
    const [delivery] = await this.db.query(
      `SELECT d.delivery_code, d.delivered_at, r.driver_id
         FROM deliveries d JOIN rides r ON r.id = d.ride_id
        WHERE d.ride_id = $1`,
      [rideId],
    );

    if (!delivery) throw new NotFoundException('delivery not found');
    if (delivery.driver_id !== driverId) {
      throw new ForbiddenException('not your delivery');
    }
    if (delivery.delivered_at) return { delivered: true, alreadyConfirmed: true };

    const supplied = (code ?? '').trim();
    const expected = String(delivery.delivery_code);
    const matches =
      supplied.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));

    if (!matches) {
      this.logger.warn(`wrong delivery code on ride ${rideId}`);
      throw new BadRequestException('that code does not match');
    }

    await this.db.query(
      `UPDATE deliveries
          SET delivered_at = now(), delivered_to = $2
        WHERE ride_id = $1`,
      [rideId, receivedBy?.trim().slice(0, 120) ?? null],
    );

    return { delivered: true };
  }

  /**
   * Records a delivery that could not be completed — nobody home, wrong
   * address, recipient refused. The item goes back to the sender, so this is
   * not the same as a cancellation and is kept separate for that reason.
   */
  async markFailed(rideId: string, driverId: string, reason: string) {
    const [row] = await this.db.query(
      `UPDATE deliveries d
          SET failure_reason = $3
         FROM rides r
        WHERE d.ride_id = $1 AND r.id = d.ride_id AND r.driver_id = $2
        RETURNING d.ride_id`,
      [rideId, driverId, reason.slice(0, 500)],
    );
    if (!row) throw new BadRequestException('not your delivery');
    this.logger.warn(`delivery ${rideId} failed: ${reason}`);
    return { recorded: true };
  }

  /** Deliveries a person sent, and ones addressed to their number. */
  async forUser(userId: string, phone: string, limit = 30) {
    return this.db.query(
      `SELECT r.id, r.reference, r.service_type, r.status, r.requested_at,
              r.pickup_address, r.dropoff_address, r.final_fare_cents,
              d.recipient_name, d.recipient_phone, d.description, d.size,
              d.collected_at, d.delivered_at, d.cash_to_collect_cents,
              CASE WHEN r.rider_id = $1 THEN 'sent' ELSE 'received' END AS direction,
              -- The code is only ever shown to the sender; a recipient learns
              -- it from them, which is what makes it proof.
              CASE WHEN r.rider_id = $1 THEN d.delivery_code ELSE NULL END AS delivery_code
         FROM rides r
         JOIN deliveries d ON d.ride_id = r.id
        WHERE r.rider_id = $1 OR d.recipient_phone = $2
        ORDER BY r.requested_at DESC
        LIMIT $3`,
      [userId, phone, Math.min(limit, 100)],
    );
  }
}
