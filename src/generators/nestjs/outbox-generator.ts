export function generateNestJsOutboxInfrastructure(): string {
  return `// --------------------------------------------------------------------------
// Transactional Outbox Pattern (NestJS + Prisma)
// --------------------------------------------------------------------------
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaClient) {}

  async saveMessage(eventType: string, payload: any, tx: any = this.prisma) {
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
