export function generateNestJsOutboxInfrastructure(): string {
  return `// --------------------------------------------------------------------------
// Transactional Outbox Pattern (NestJS + Prisma)
// Atomic Claim with FOR UPDATE SKIP LOCKED to prevent dual-publish
// --------------------------------------------------------------------------
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

export interface OutboxMessage {
  id: string;
  eventType: string;
  payload: string;
  occurredOn: Date;
  processedOn: Date | null;
  retryCount: number;
  lastError: string | null;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Save an outbox message within the same transaction as the domain model.
   * This guarantees atomicity: either both the domain change AND the outbox
   * message are saved, or neither is.
   */
  async saveMessage(eventType: string, payload: any, tx: any = this.prisma) {
    await tx.outboxMessage.create({
      data: {
        eventType,
        payload: JSON.stringify(payload),
        occurredOn: new Date(),
        retryCount: 0,
      },
    });
  }

  /**
   * Atomically claim unprocessed messages using FOR UPDATE SKIP LOCKED.
   * This prevents multiple workers from processing the same message.
   * Returns claimed message IDs and their data.
   */
  async claimAndProcessMessages(
    batchSize: number = 50,
    maxRetries: number = 5,
  ): Promise<OutboxMessage[]> {
    // Use raw SQL for FOR UPDATE SKIP LOCKED (not supported natively by Prisma)
    const claimed = await this.prisma.$queryRaw<OutboxMessage[]>\`
      UPDATE "OutboxMessage"
      SET "processedOn" = NOW()
      WHERE id IN (
        SELECT id FROM "OutboxMessage"
        WHERE "processedOn" IS NULL
          AND "retryCount" < \${maxRetries}
        ORDER BY "occurredOn" ASC
        LIMIT \${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    \`;

    return claimed;
  }

  /**
   * Mark a message as failed, incrementing retry count.
   * After maxRetries, message becomes a dead letter.
   */
  async markAsFailed(id: string, error: string) {
    await this.prisma.outboxMessage.update({
      where: { id },
      data: {
        processedOn: null, // Reset to allow retry
        retryCount: { increment: 1 },
        lastError: error,
      },
    });
  }

  /**
   * Move permanently failed messages to dead letter state.
   */
  async getDeadLetterMessages(maxRetries: number = 5) {
    return this.prisma.outboxMessage.findMany({
      where: {
        processedOn: null,
        retryCount: { gte: maxRetries },
      },
      orderBy: { occurredOn: 'asc' },
    });
  }
}

export interface IMessageBrokerPublisher {
  publish(eventType: string, payload: any): Promise<void>;
}

@Injectable()
export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name);
  private processing = false;

  constructor(
    private readonly outboxService: OutboxService,
    private readonly messageBroker: IMessageBrokerPublisher,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processOutboxMessages() {
    // Prevent overlapping runs
    if (this.processing) return;
    this.processing = true;

    try {
      // Atomically claim messages — no other worker can claim the same ones
      const messages = await this.outboxService.claimAndProcessMessages();

      if (messages.length > 0) {
        this.logger.log(\`Processing \${messages.length} outbox message(s)\`);
      }

      for (const msg of messages) {
        try {
          await this.messageBroker.publish(msg.eventType, JSON.parse(msg.payload));
        } catch (error) {
          this.logger.error(\`Failed to publish outbox message \${msg.id}: \${error}\`);
          // Revert: mark as failed so it can be retried
          await this.outboxService.markAsFailed(msg.id, String(error));
        }
      }
    } catch (error) {
      this.logger.error(\`Outbox processing cycle failed: \${error}\`);
    } finally {
      this.processing = false;
    }
  }
}
`;
}
