import { Injectable } from '@nestjs/common';
@Injectable()
export class PrismaService {
  isConnected = true;
  order: any;
}
