import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthedUser {
  id: string;
  phone: string;
  role: 'rider' | 'driver' | 'admin';
  driverId?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser =>
    ctx.switchToHttp().getRequest().user,
);
