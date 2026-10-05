export function generateNestJsIdempotencyInterceptor(): string {
  return `// --------------------------------------------------------------------------
// Idempotent Consumer (NestJS Interceptor) with TTL + Cleanup
// Prevents stuck keys from blocking retries. Keys expire after TTL.
// --------------------------------------------------------------------------
import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException, HttpStatus, Logger, OnModuleInit } from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/** TTL in milliseconds for processing keys (default: 30 seconds) */
const PROCESSING_TTL_MS = 30_000;
/** TTL in milliseconds for completed keys (default: 24 hours) */
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return next.handle();
    }

    // Check for existing key
    const existing = await this.prisma.processedEvent.findUnique({
      where: { eventId: idempotencyKey },
    });

    if (existing) {
      // If completed, return cached response
      if (existing.status === 'COMPLETED' && existing.responseBody) {
        this.logger.debug(\`Idempotency hit (COMPLETED): \${idempotencyKey}\`);
        return of(JSON.parse(existing.responseBody));
      }

      // If still processing, check TTL
      const processingAge = Date.now() - existing.processedAt.getTime();
      if (existing.status === 'PROCESSING' && processingAge < PROCESSING_TTL_MS) {
        throw new HttpException(
          'Request already in progress. Retry after a moment.',
          HttpStatus.CONFLICT,
        );
      }

      // TTL expired for PROCESSING, or FAILED — re-claim with compare-and-set on (status, processedAt):
      // if a concurrent retry re-claimed the key first, the condition no longer matches and count is 0.
      if (existing.status === 'PROCESSING' || existing.status === 'FAILED') {
        const reclaimed = await this.prisma.processedEvent.updateMany({
          where: {
            eventId: idempotencyKey,
            status: existing.status,
            processedAt: existing.processedAt,
          },
          data: {
            status: 'PROCESSING',
            processedAt: new Date(),
            responseBody: '',
          },
        });
        if (reclaimed.count !== 1) {
          throw new HttpException('Request already in progress', HttpStatus.CONFLICT);
        }
        this.logger.warn(\`Idempotency key \${idempotencyKey} expired/failed — retrying\`);
        return this.executeAndStore(next, idempotencyKey);
      }
    }

    // New key — claim it atomically
    try {
      await this.prisma.processedEvent.create({
        data: {
          eventId: idempotencyKey,
          responseBody: '',
          processedAt: new Date(),
          status: 'PROCESSING',
        },
      });
    } catch (err: any) {
      // Race condition: another request claimed it between our check and insert
      throw new HttpException('Request already in progress', HttpStatus.CONFLICT);
    }

    return this.executeAndStore(next, idempotencyKey);
  }

  private executeAndStore(next: CallHandler, idempotencyKey: string): Observable<any> {
    return next.handle().pipe(
      tap(async (response) => {
        try {
          await this.prisma.processedEvent.update({
            where: { eventId: idempotencyKey },
            data: {
              responseBody: JSON.stringify(response),
              status: 'COMPLETED',
            },
          });
        } catch (err) {
          this.logger.error(\`Failed to store idempotency result for \${idempotencyKey}: \${err}\`);
        }
      }),
      catchError(async (error) => {
        // On handler failure, mark as FAILED so the key can be retried
        try {
          await this.prisma.processedEvent.update({
            where: { eventId: idempotencyKey },
            data: {
              status: 'FAILED',
              responseBody: JSON.stringify({ error: error.message }),
            },
          });
        } catch (updateErr) {
          this.logger.error(\`Failed to mark idempotency key as FAILED: \${updateErr}\`);
        }
        throw error;
      }),
    );
  }
}

/**
 * Cleanup service that purges expired idempotency keys.
 * - PROCESSING keys older than PROCESSING_TTL_MS are cleaned up
 * - COMPLETED keys older than COMPLETED_TTL_MS are cleaned up
 */
@Injectable()
export class IdempotencyCleanupService {
  private readonly logger = new Logger(IdempotencyCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredKeys() {
    const processingCutoff = new Date(Date.now() - PROCESSING_TTL_MS);
    const completedCutoff = new Date(Date.now() - COMPLETED_TTL_MS);

    const result = await this.prisma.processedEvent.deleteMany({
      where: {
        OR: [
          { status: 'PROCESSING', processedAt: { lt: processingCutoff } },
          { status: 'FAILED', processedAt: { lt: processingCutoff } },
          { status: 'COMPLETED', processedAt: { lt: completedCutoff } },
        ],
      },
    });

    if (result.count > 0) {
      this.logger.log(\`Cleaned up \${result.count} expired idempotency key(s)\`);
    }
  }
}
`;
}
