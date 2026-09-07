import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { IsIn, IsString, Length } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { UsersService, SUPPORTED_LANGUAGES } from './users.service';

class SetLanguageDto {
  @IsIn(SUPPORTED_LANGUAGES as unknown as string[], {
    message: `language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`,
  })
  language: string;
}

class SetNameDto {
  @IsString()
  @Length(2, 120, { message: 'name must be 2-120 characters' })
  fullName: string;
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthedUser) {
    return this.users.profile(user.id);
  }

  /**
   * The app switches language locally and instantly, then calls this so the
   * server knows which language to send SMS and push notifications in. A
   * failure here is non-fatal for the client.
   */
  /** Set once at signup; editable afterwards from the account screen. */
  @Patch('me')
  setName(@CurrentUser() user: AuthedUser, @Body() dto: SetNameDto) {
    return this.users.setName(user.id, dto.fullName);
  }

  @Patch('me/language')
  setLanguage(@CurrentUser() user: AuthedUser, @Body() dto: SetLanguageDto) {
    return this.users.setLanguage(user.id, dto.language);
  }
}
