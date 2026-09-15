export function generateNestJsIdempotencyInterceptor(): string {
  return `// --------------------------------------------------------------------------
// Idempotent Consumer (NestJS Interceptor)
// --------------------------------------------------------------------------
import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaClient) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return next.handle();
    }

    try {
      // Atomic insertion to claim the idempotency key (status: PROCESSING)
      await this.prisma.processedEvent.create({
        data: {
          eventId: idempotencyKey,
          responseBody: '',
          processedAt: new Date(),
          status: 'PROCESSING'
        }
      });
    } catch (err: any) {
      // Unique constraint violation: Key already exists
      const existing = await this.prisma.processedEvent.findUnique({
        where: { eventId: idempotencyKey }
      });
      if (existing && existing.status === 'COMPLETED') {
        return of(JSON.parse(existing.responseBody));
      } else {
        throw new HttpException('Request already in progress', HttpStatus.CONFLICT);
      }
    }

    return next.handle().pipe(
      tap(async (response) => {
        try {
          await this.prisma.processedEvent.update({
            where: { eventId: idempotencyKey },
            data: {
              responseBody: JSON.stringify(response),
              status: 'COMPLETED'
            }
          });
        } catch (err) {
          // Ignore if updating fails for unforeseen reasons
        }
      })
    );
  }
}
`;
}
