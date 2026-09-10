/**
 * Profile photos.
 *
 * Required by LATRA: the operator-licence app test checks that a rider can
 * see the driver's name and photo.
 *
 * Three properties matter here, in order:
 *
 *   EXIF is stripped. A phone photo carries the GPS coordinates of where it
 *   was taken — frequently someone's home. Re-encoding through Jimp drops
 *   all metadata, which is the main reason images are processed rather than
 *   stored as uploaded.
 *
 *   Photos are addressed by an unguessable key. Serving /photos/{user-id}
 *   would let anyone iterate every face on the platform.
 *
 *   Size is bounded twice — once in the service, once by a database
 *   constraint — because an unbounded image column is how a small table
 *   becomes the largest thing in the database.
 */

import { Injectable, Logger, BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Jimp } from 'jimp';
import * as crypto from 'node:crypto';

/** Longest side of the stored image. Enough for a 3x avatar on any handset. */
const TARGET_PX = 512;
const JPEG_QUALITY = 78;

/** Largest upload accepted, before resizing. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Must stay under the database CHECK constraint. */
const MAX_STORED_BYTES = 400_000;

@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name);

  constructor(private readonly db: DataSource) {}

  /**
   * Accepts a base64 data URL or raw base64, normalises it, and stores it.
   * Returns the new key; the old one stops resolving immediately.
   */
  async setPhoto(userId: string, input: string) {
    if (!input || typeof input !== 'string') {
      throw new BadRequestException('no image supplied');
    }

    // Accept "data:image/jpeg;base64,...." or bare base64.
    const base64 = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input;

    let raw: Buffer;
    try {
      raw = Buffer.from(base64, 'base64');
    } catch {
      throw new BadRequestException('image is not valid base64');
    }

    if (raw.length === 0) throw new BadRequestException('image is empty');
    if (raw.length > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException('image must be under 8 MB');
    }

    // Reject anything that is not actually an image before handing it to the
    // decoder. Magic bytes, not the declared content type — the declared type
    // is attacker-controlled.
    if (!this.looksLikeImage(raw)) {
      throw new BadRequestException('file is not a JPEG or PNG image');
    }

    let jpeg: Buffer;
    try {
      const image = await Jimp.read(raw);

      // Square centre crop. A profile photo is displayed in a circle
      // everywhere in this product, so cropping here means the apps never
      // have to guess at a sensible crop.
      const side = Math.min(image.bitmap.width, image.bitmap.height);
      image.crop({
        x: Math.round((image.bitmap.width - side) / 2),
        y: Math.round((image.bitmap.height - side) / 2),
        w: side,
        h: side,
      });
      image.resize({ w: TARGET_PX, h: TARGET_PX });

      // Re-encoding is what drops the EXIF block, GPS included.
      jpeg = await image.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
    } catch (err) {
      this.logger.warn(`image decode failed: ${(err as Error).message}`);
      throw new BadRequestException('could not read that image');
    }

    if (jpeg.length > MAX_STORED_BYTES) {
      // Should not happen at 512px, but the constraint would reject it and a
      // clear message beats a database error.
      throw new PayloadTooLargeException('processed image is too large');
    }

    const key = crypto.randomBytes(24).toString('base64url'); // 32 chars

    await this.db.query(
      `UPDATE users
          SET photo_key = $2, photo_bytes = $3, photo_mime = 'image/jpeg',
              photo_updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId, key, jpeg],
    );

    this.logger.log(
      `photo stored for ${userId}: ${(raw.length / 1024).toFixed(0)} KB in, ` +
        `${(jpeg.length / 1024).toFixed(0)} KB out`,
    );

    return { photoKey: key, url: `/api/photos/${key}`, bytes: jpeg.length };
  }

  /** Serves a photo by its capability key. */
  async getByKey(key: string) {
    if (!/^[A-Za-z0-9_-]{20,43}$/.test(key)) return null;

    const [row] = await this.db.query(
      `SELECT photo_bytes, photo_mime, photo_updated_at
         FROM users WHERE photo_key = $1 AND deleted_at IS NULL`,
      [key],
    );
    if (!row?.photo_bytes) return null;

    return {
      bytes: row.photo_bytes as Buffer,
      mime: row.photo_mime ?? 'image/jpeg',
      updatedAt: row.photo_updated_at as Date,
    };
  }

  async remove(userId: string) {
    await this.db.query(
      `UPDATE users
          SET photo_key = NULL, photo_bytes = NULL, photo_mime = NULL,
              photo_updated_at = NULL
        WHERE id = $1`,
      [userId],
    );
    return { removed: true };
  }

  /**
   * Checks magic bytes rather than the declared type, which the client
   * controls. Only JPEG and PNG are accepted; everything else a phone camera
   * produces converts to one of the two before upload.
   */
  private looksLikeImage(buf: Buffer): boolean {
    if (buf.length < 8) return false;
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const png =
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    return jpeg || png;
  }
}
