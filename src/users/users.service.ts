import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Interface languages the platform supports. Mirrors the CHECK constraint. */
export const SUPPORTED_LANGUAGES = ['sw', 'en', 'fr'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

@Injectable()
export class UsersService {
  constructor(private readonly db: DataSource) {}

  /**
   * Persists the interface language. This is not cosmetic on the server side:
   * it decides what language OTP messages, push notifications and receipts go
   * out in, which is the part the app cannot do for itself.
   */
  async setLanguage(userId: string, language: string) {
    if (!SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)) {
      throw new BadRequestException(
        `language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`,
      );
    }

    const [row] = await this.db.query(
      `UPDATE users SET preferred_language = $2
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, preferred_language`,
      [userId, language],
    );

    if (!row) throw new BadRequestException('user_not_found');
    return { language: row.preferred_language };
  }

  async profile(userId: string) {
    const [row] = await this.db.query(
      `SELECT u.id, u.phone, u.full_name, u.preferred_language,
              u.rating_avg, u.rating_count, u.created_at,
              d.id AS driver_id, d.state AS driver_state
         FROM users u
         LEFT JOIN drivers d ON d.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );
    if (!row) throw new BadRequestException('user_not_found');

    return {
      id: row.id,
      phone: row.phone,
      fullName: row.full_name,
      language: row.preferred_language,
      rating: Number(row.rating_avg),
      ratingCount: Number(row.rating_count),
      isDriver: Boolean(row.driver_id),
      driverState: row.driver_state ?? null,
      memberSince: row.created_at,
    };
  }
}
