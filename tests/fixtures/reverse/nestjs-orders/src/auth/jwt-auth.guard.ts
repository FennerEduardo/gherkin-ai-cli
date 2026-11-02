import { Injectable } from '@nestjs/common';
@Injectable()
export class JwtAuthGuard {
  canActivate(): boolean { return true; }
}
