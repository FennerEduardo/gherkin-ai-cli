export function generateNestJsOutboxInfrastructure(): string {
  return `// --------------------------------------------------------------------------
// Transactional Outbox Pattern (NestJS + Prisma)
// --------------------------------------------------------------------------
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

export interface IMessageBrokerPublisher {
  publish(eventType: string, payload: any): Promise<void>;
}

@Injectable()
export class OutboxProcessor {
  constructor(
    private readonly outboxService: OutboxService,
    private readonly messageBroker: IMessageBrokerPublisher,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processOutboxMessages() {
    const messages = await this.outboxService.getUnprocessedMessages();

    for (const msg of messages) {
      try {
        await this.messageBroker.publish(msg.eventType, JSON.parse(msg.payload));
        await this.outboxService.markAsProcessed(msg.id);
      } catch (error) {
        // Implement retry logic or dead-letter queue as necessary
        console.error(\`Failed to process outbox message \${msg.id}\`, error);
      }
    }
  }
}
`;
}
