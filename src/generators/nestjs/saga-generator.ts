// --------------------------------------------------------------------------
// Saga Orchestration Pattern for NestJS + Prisma
// PARAMETRIZED: Generates saga based on feature name
// --------------------------------------------------------------------------

export function generateNestJsSagaInfrastructure(featureName?: string): { filename: string; content: string }[] {
  const feature = featureName
    ? featureName.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
    : 'Payment';
  const featureLower = feature.charAt(0).toLowerCase() + feature.slice(1);
  const entityId = featureLower + 'Id';

  const sagaEventsAndCommands = `// --------------------------------------------------------------------------
// Saga Contracts for ${feature}
// --------------------------------------------------------------------------

// === Events ===
export class ${feature}InitiatedEvent {
  constructor(public readonly correlationId: string, public readonly ${entityId}: string, public readonly metadata: any) {}
}
export class ${feature}AuthorizedEvent {
  constructor(public readonly correlationId: string) {}
}
export class ${feature}CompletedEvent {
  constructor(public readonly correlationId: string) {}
}
export class ${feature}FailedEvent {
  constructor(public readonly correlationId: string, public readonly reason: string) {}
}

// === Commands ===
export class Authorize${feature}Command {
  constructor(public readonly ${entityId}: string, public readonly metadata: any) {}
}
export class Complete${feature}Command {
  constructor(public readonly ${entityId}: string) {}
}
export class Compensate${feature}Command {
  constructor(public readonly ${entityId}: string, public readonly reason: string) {}
}
`;

  const sagaOrchestrator = `import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler, EventBus } from '@nestjs/cqrs';
import { PrismaService } from '../prisma/prisma.service';
import {
  ${feature}InitiatedEvent,
  ${feature}AuthorizedEvent,
  ${feature}CompletedEvent,
  ${feature}FailedEvent,
  Authorize${feature}Command,
  Complete${feature}Command,
  Compensate${feature}Command,
} from './${featureLower}-saga.contracts';

@Injectable()
export class ${feature}SagaOrchestrator {
  private readonly logger = new Logger(${feature}SagaOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Main entry point for events into the saga.
   * This acts as the state machine transition engine.
   */
  async handleEvent(event: any) {
    if (event instanceof ${feature}InitiatedEvent) {
      await this.handleInitiated(event);
    } else if (event instanceof ${feature}AuthorizedEvent) {
      await this.handleAuthorized(event);
    } else if (event instanceof ${feature}CompletedEvent) {
      await this.handleCompleted(event);
    } else if (event instanceof ${feature}FailedEvent) {
      await this.handleFailed(event);
    }
  }

  private async handleInitiated(event: ${feature}InitiatedEvent) {
    this.logger.log(\`Saga initiated: \${event.correlationId}\`);
    
    // Save initial state to DB
    await this.prisma.sagaInstance.create({
      data: {
        id: event.correlationId,
        sagaType: '${feature}',
        currentState: 'STARTED',
        entityId: event.${entityId},
        metadata: JSON.stringify(event.metadata),
      },
    });

    // Dispatch next command via EventBus (or Outbox)
    this.eventBus.publish(new Authorize${feature}Command(event.${entityId}, event.metadata));
  }

  private async handleAuthorized(event: ${feature}AuthorizedEvent) {
    this.logger.log(\`Saga authorized: \${event.correlationId}\`);

    const saga = await this.prisma.sagaInstance.findUnique({ where: { id: event.correlationId } });
    if (!saga) throw new Error(\`Saga not found: \${event.correlationId}\`);

    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { currentState: 'COMPLETING', updatedAt: new Date() },
    });

    this.eventBus.publish(new Complete${feature}Command(saga.entityId));
  }

  private async handleCompleted(event: ${feature}CompletedEvent) {
    this.logger.log(\`Saga completed: \${event.correlationId}\`);
    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { currentState: 'COMPLETED', updatedAt: new Date() },
    });
  }

  private async handleFailed(event: ${feature}FailedEvent) {
    this.logger.warn(\`Saga failed: \${event.correlationId}, reason: \${event.reason}\`);
    
    const saga = await this.prisma.sagaInstance.findUnique({ where: { id: event.correlationId } });
    if (!saga) throw new Error(\`Saga not found: \${event.correlationId}\`);

    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { 
        currentState: 'COMPENSATING', 
        errorReason: event.reason,
        updatedAt: new Date() 
      },
    });

    this.eventBus.publish(new Compensate${feature}Command(saga.entityId, event.reason));
    
    // Once compensation command is sent, we can mark it failed
    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { currentState: 'FAILED', updatedAt: new Date() },
    });
  }
}

// Global Event Handler to route events into the Saga Orchestrator
@EventsHandler(
  ${feature}InitiatedEvent,
  ${feature}AuthorizedEvent,
  ${feature}CompletedEvent,
  ${feature}FailedEvent,
)
export class ${feature}SagaEventHandler implements IEventHandler<any> {
  constructor(private readonly orchestrator: ${feature}SagaOrchestrator) {}

  async handle(event: any) {
    await this.orchestrator.handleEvent(event);
  }
}
`;

  return [
    { filename: `src/sagas/${featureLower}-saga.contracts.ts`, content: sagaEventsAndCommands },
    { filename: `src/sagas/${featureLower}-saga.orchestrator.ts`, content: sagaOrchestrator }
  ];
}
