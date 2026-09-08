/**
 * Driver applications submitted from the public website.
 *
 * This endpoint is unauthenticated, which makes it the most exposed surface
 * on the platform. Three consequences shape the code below:
 *
 *   It creates a lead, never a driver. Nothing here grants access, puts a
 *   vehicle on the road, or touches the dispatch pool.
 *
 *   It never reveals whether a number is already known. "You have already
 *   applied" would turn the form into a way to test whether a given phone
 *   number is registered with the platform, so every valid submission gets
 *   the same answer.
 *
 *   Resubmission updates rather than duplicates. People resubmit when a form
 *   does not visibly confirm, and a queue full of the same person is a real
 *   operational cost.
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface ApplicationInput {
  fullName: string;
  phone: string;
  email?: string;
  city?: string;
  vehicleType?: string;
  consent: boolean;
  sourceIp?: string;
  userAgent?: string;
}

const CATEGORIES = ['boda', 'bajaji', 'standard', 'xl', 'express'];

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(private readonly db: DataSource) {}

  async submit(input: ApplicationInput) {
    const name = input.fullName?.trim().replace(/\s+/g, ' ') ?? '';
    const phone = input.phone?.replace(/\s/g, '') ?? '';
    const email = input.email?.trim().toLowerCase() || null;

    if (name.length < 2 || name.length > 120) {
      throw new BadRequestException('name must be 2-120 characters');
    }
    if (!/^\+255[0-9]{9}$/.test(phone)) {
      throw new BadRequestException('phone must be +255XXXXXXXXX');
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('email is not valid');
    }
    if (!input.consent) {
      // Without consent there is no lawful basis to hold the record, so the
      // right response is to not store it at all rather than store it and
      // flag it.
      throw new BadRequestException('consent is required');
    }

    const vehicleType =
      input.vehicleType && CATEGORIES.includes(input.vehicleType)
        ? input.vehicleType
        : null;

    await this.db.query(
      `INSERT INTO driver_applications
         (full_name, phone, email, city, vehicle_type, source_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5::vehicle_category, $6::inet, $7)
       ON CONFLICT (phone) WHERE status IN ('new','contacted','documents')
       DO UPDATE SET
         full_name = EXCLUDED.full_name,
         email = COALESCE(EXCLUDED.email, driver_applications.email),
         city = COALESCE(EXCLUDED.city, driver_applications.city),
         vehicle_type = COALESCE(EXCLUDED.vehicle_type, driver_applications.vehicle_type),
         updated_at = now()`,
      [
        name,
        phone,
        email,
        input.city?.trim() || null,
        vehicleType,
        input.sourceIp ?? null,
        input.userAgent?.slice(0, 400) ?? null,
      ],
    );

    this.logger.log(`driver application received for ${phone}`);

    // Identical response whether this was new or an update — see the note at
    // the top about not leaking which numbers are known.
    return { received: true };
  }

  // -------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------

  async list(status = 'new', limit = 100) {
    const clause = status === 'all'
      ? ''
      : `WHERE status = '${status.replace(/[^a-z]/g, '')}'::application_status`;

    return this.db.query(
      `SELECT a.id, a.full_name, a.phone, a.email, a.city, a.vehicle_type,
              a.status, a.notes, a.created_at, a.updated_at,
              -- Whether they have since signed up in the app. Until they do,
              -- their number is unverified and no driver record can be made.
              EXISTS (
                SELECT 1 FROM users u
                 WHERE u.phone = a.phone AND u.deleted_at IS NULL
              ) AS has_account
         FROM driver_applications a
         ${clause}
        ORDER BY a.created_at DESC
        LIMIT $1`,
      [Math.min(limit, 300)],
    );
  }

  async setStatus(id: string, status: string, adminId: string, notes?: string) {
    const allowed = ['new', 'contacted', 'documents', 'approved', 'rejected', 'duplicate'];
    if (!allowed.includes(status)) throw new BadRequestException('invalid status');

    const [row] = await this.db.query(
      `UPDATE driver_applications
          SET status = $2::application_status,
              notes = COALESCE($3, notes),
              handled_by = $4,
              handled_at = now()
        WHERE id = $1
        RETURNING id, status`,
      [id, status, notes ?? null, adminId],
    );
    if (!row) throw new BadRequestException('application_not_found');
    return row;
  }

  async counts() {
    const rows = await this.db.query(
      `SELECT status, COUNT(*)::int AS n FROM driver_applications GROUP BY status`,
    );
    return rows.reduce(
      (acc: Record<string, number>, r: any) => ({ ...acc, [r.status]: r.n }),
      {},
    );
  }
}
