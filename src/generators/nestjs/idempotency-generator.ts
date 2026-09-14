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

    // Check if event was already processed
    const existing = await this.prisma.processedEvent.findUnique({
      where: { eventId: idempotencyKey }
    });

    if (existing) {
      // Return previously saved response
      return of(JSON.parse(existing.responseBody));
    }

    return next.handle().pipe(
      tap(async (response) => {
        try {
          await this.prisma.processedEvent.create({
            data: {
              eventId: idempotencyKey,
              responseBody: JSON.stringify(response),
              processedAt: new Date()
            }
          });
        } catch (err) {
          // Ignore uniqueness constraint violations if race condition occurred
        }
      })
    );
  }
}
`;
}
