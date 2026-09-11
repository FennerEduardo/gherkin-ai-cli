export function generateNestJsCqrsModules(): string {
  return `// --------------------------------------------------------------------------
// Plantilla base para CQRS en NestJS / Base template for CQRS in NestJS
// --------------------------------------------------------------------------
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

// Comandos / Commands
export class CreateTransactionCommand {
  constructor(
    public readonly tenantId: string,
    public readonly amount: number,
    public readonly currency: string
  ) {}
}

// Queries
export class GetTransactionQuery {
  constructor(public readonly transactionId: string) {}
}

// Eventos / Events
export class TransactionCreatedEvent {
  constructor(
    public readonly transactionId: string,
    public readonly amount: number
  ) {}
}

@Module({
  imports: [CqrsModule],
  providers: [
    // CommandHandlers, QueryHandlers, EventHandlers
  ],
})
export class ApplicationCqrsModule {}
`;
}
