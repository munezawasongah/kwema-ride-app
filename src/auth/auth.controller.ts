import { Body, Controller, Post, UseGuards, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Matches, Length } from 'class-validator';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

class RequestOtpDto {
  @Matches(/^\+255[0-9]{9}$/, { message: 'phone must be +255XXXXXXXXX' })
  phone: string;
}

class VerifyOtpDto {
  @Matches(/^\+255[0-9]{9}$/)
  phone: string;

  @Length(6, 6)
  code: string;

  @IsString()
  deviceId: string;
}

class RefreshDto {
  @IsString()
  refreshToken: string;

  @IsString()
  deviceId: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Each OTP costs money and lands on a real handset, so the strict bucket.
  @Throttle({ strict: { limit: 3, ttl: 60_000 } })
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  @Throttle({ strict: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code, dto.deviceId);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken, dto.deviceId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Req() req: Request, @Body() body: { refreshToken?: string }) {
    const jti = (req as any).user?.jti ?? '';
    await this.auth.logout(jti, body?.refreshToken);
    return { ok: true };
  }
}
