/* ==========================================================================
   gherkin-ai-cli - Distributed Topology Validator
   
   Validates consistency of distributed systems primitives within the IR:
   channels, outbox, inbox, sagas, projections, and tenant context.
   ========================================================================== */

import { ValidatorContext, ValidationResult } from './index';

export function validateDistributedTopology(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  // This validator operates on file content to detect topology inconsistencies
  // It checks for patterns that indicate missing distributed primitives

  const allContent = context.files.map(f => f.content).join('\n');
  const hasEvents = context.files.some(f =>
    f.content.includes('DomainEvent') || f.content.includes('IDomainEvent') ||
    f.content.includes('EventType') || f.content.includes('domainEvent')
  );
  const hasOutbox = context.files.some(f =>
    f.content.includes('OutboxMessage') || f.content.includes('outbox_messages') ||
    f.content.includes('OutboxService') || f.content.includes('outboxMessage')
  );
  const hasSaga = context.files.some(f =>
    f.content.includes('SagaState') || f.content.includes('SagaInstance') ||
    f.content.includes('SagaStateMachine') || f.content.includes('saga_instances')
  );
  const hasDLQ = context.files.some(f =>
    f.content.includes('dlq') || f.content.includes('DLQ') ||
    f.content.includes('DeadLetter') || f.content.includes('dead_letter')
  );
  const hasRetry = context.files.some(f =>
    f.content.includes('RetryCount') || f.content.includes('retryCount') ||
    f.content.includes('retry_count') || f.content.includes('maxRetries')
  );
  const hasTenantId = context.files.some(f =>
    f.content.includes('tenantId') || f.content.includes('TenantId') ||
    f.content.includes('tenant_id')
  );
  const hasProjection = context.files.some(f =>
    f.content.includes('Projection') || f.content.includes('ReadModel') ||
    f.content.includes('projection') || f.content.includes('readModel')
  );
  const isCqrs = context.rules.includes('cqrs') ||
    context.files.some(f => f.content.includes('CQRS') || f.content.includes('CommandHandler'));

  // Rule 1: Events without outbox in CQRS architecture
  if (hasEvents && isCqrs && !hasOutbox) {
    result.warnings.push(
      'Distributed Topology: CQRS architecture with domain events detected but no Outbox pattern found. ' +
      'Consider implementing Transactional Outbox to guarantee event delivery.'
    );
  }

  // Rule 2: Retry without DLQ
  if (hasRetry && !hasDLQ) {
    result.warnings.push(
      'Distributed Topology: Retry logic detected but no Dead Letter Queue (DLQ) configuration found. ' +
      'Messages that exceed retry limits should be routed to a DLQ for manual inspection.'
    );
  }

  // Rule 3: Saga without compensation patterns
  if (hasSaga) {
    const hasCompensation = context.files.some(f =>
      f.content.includes('Compensat') || f.content.includes('compensat') ||
      f.content.includes('Cancel') || f.content.includes('Rollback')
    );
    if (!hasCompensation) {
      result.warnings.push(
        'Distributed Topology: Saga orchestration detected but no compensation commands found. ' +
        'Each saga step should have a corresponding compensation action for failure recovery.'
      );
    }
  }

  // Rule 4: Tenant context propagation
  if (hasTenantId) {
    const commandFiles = context.files.filter(f =>
      f.content.includes('Command') || f.content.includes('command')
    );
    const eventFiles = context.files.filter(f =>
      f.content.includes('Event') || f.content.includes('event')
    );

    const commandsWithTenant = commandFiles.some(f => f.content.includes('tenantId') || f.content.includes('TenantId'));
    const eventsWithTenant = eventFiles.some(f => f.content.includes('tenantId') || f.content.includes('TenantId'));

    if (commandsWithTenant && !eventsWithTenant) {
      result.warnings.push(
        'Distributed Topology: TenantId found in commands but not in events. ' +
        'Ensure tenant context is propagated through the entire event chain for proper isolation.'
      );
    }
  }

  // Rule 5: Events without projections in CQRS
  if (hasEvents && isCqrs && !hasProjection) {
    result.warnings.push(
      'Distributed Topology: CQRS with events detected but no projections or read models found. ' +
      'Consider adding event-driven projections to maintain query-optimized read models.'
    );
  }

  return result;
}
