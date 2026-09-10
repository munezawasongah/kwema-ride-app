import {
  Body, Controller, Delete, Get, Header, Param, Post, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString } from 'class-validator';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { PhotosService } from './photos.service';

class UploadDto {
  /** Base64 data URL or bare base64. */
  @IsString() image: string;
}

@Controller()
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  /**
   * Serves a photo by its capability key.
   *
   * Unauthenticated on purpose: the key is the credential. Requiring a token
   * would mean the apps could not use ordinary cached image loading, and the
   * key is unguessable, rotates on re-upload, and reveals nothing about
   * whose photo it is.
   */
  @Get('photos/:key')
  @Header('Cache-Control', 'public, max-age=86400, immutable')
  async serve(@Param('key') key: string, @Res() res: Response) {
    const photo = await this.photos.getByKey(key);
    if (!photo) {
      res.status(404).json({ message: 'not found' });
      return;
    }
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Content-Length', photo.bytes.length);
    res.send(photo.bytes);
  }

  /** Upload or replace your own photo. Rate-limited: each one costs CPU. */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @Post('users/me/photo')
  upload(@CurrentUser() user: AuthedUser, @Body() dto: UploadDto) {
    return this.photos.setPhoto(user.id, dto.image);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('users/me/photo')
  remove(@CurrentUser() user: AuthedUser) {
    return this.photos.remove(user.id);
  }
}
