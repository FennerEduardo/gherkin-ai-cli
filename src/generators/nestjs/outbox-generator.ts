export function generateNestJsOutboxInfrastructure(): string {
  return `// --------------------------------------------------------------------------
// Patrón Transactional Outbox (NestJS + Prisma) / Transactional Outbox Pattern
// --------------------------------------------------------------------------
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaClient) {}

  async saveMessage(eventType: string, payload: any, tx: any = this.prisma) {
    // Se guarda en la misma transacción Prisma que el modelo de dominio
    // Saved within the same Prisma transaction as the domain model
    await tx.outboxMessage.create({
      data: {
        eventType,
        payload: JSON.stringify(payload),
        occurredOn: new Date(),
      },
    });
  }

  async getUnprocessedMessages() {
    return this.prisma.outboxMessage.findMany({
      where: { processedOn: null },
      take: 50,
      orderBy: { occurredOn: 'asc' },
    });
  }

  async markAsProcessed(id: string) {
    await this.prisma.outboxMessage.update({
      where: { id },
      data: { processedOn: new Date() },
    });
  }
}
`;
}
