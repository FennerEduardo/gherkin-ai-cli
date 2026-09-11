export function generateNestJsIdempotencyInterceptor(): string {
  return `// --------------------------------------------------------------------------
// Consumidor Idempotente / Idempotent Consumer (NestJS Interceptor)
// --------------------------------------------------------------------------
import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';
import { Observable, of } from 'rxjs';
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

    // Verificar si el evento ya fue procesado / Check if event was already processed
    const existing = await this.prisma.processedEvent.findUnique({
      where: { eventId: idempotencyKey }
    });

    if (existing) {
      // Retornar la respuesta guardada previamente / Return previously saved response
      return of(JSON.parse(existing.responseBody));
    }

    return next.handle();
    // Nota: El guardado del evento debe hacerse tras procesarse con éxito en el pipeline principal.
    // Note: The event must be saved after successful processing in the main pipeline.
  }
}
`;
}
