/* ==========================================================================
   gherkin-ai-cli - Architecture Rule Engine & Pattern Definitions
   ========================================================================== */

export interface ArchRuleSpec {
  id: string;
  name: string;
  description: string;
  patterns: string[];
  folderStructure: string;
  prohibitedImports: string[];
}

export const ARCH_RULES: Record<string, ArchRuleSpec> = {
  ddd: {
    id: 'ddd',
    name: 'Domain-Driven Design (DDD)',
    description: 'Business domain-driven design focused on Bounded Contexts, Aggregates, Entities, Value Objects, Domain Events, and Repositories.',
    patterns: ['Bounded Context', 'Aggregate Root', 'Entity', 'Value Object', 'Domain Service', 'Repository Port', 'Domain Event', 'Application Use Case'],
    folderStructure: `src/
  ├── domain/
  │   ├── entities/
  │   ├── value-objects/
  │   ├── aggregates/
  │   ├── events/
  │   └── ports/
  ├── application/
  │   ├── use-cases/
  │   └── dtos/
  └── infrastructure/
      ├── persistence/
      └── http/`,
    prohibitedImports: ['express', '@nestjs/common', 'prisma', 'typeorm', 'pg']
  },
  hexagonal: {
    id: 'hexagonal',
    name: 'Hexagonal Architecture (Ports & Adapters)',
    description: 'Isolated domain core connected to external frameworks via inbound and outbound ports and adapters.',
    patterns: ['Inbound Port', 'Outbound Port', 'Inbound Adapter (HTTP/CLI)', 'Outbound Adapter (DB/Queue)', 'Domain Core'],
    folderStructure: `src/
  ├── core/
  │   ├── domain/
  │   └── ports/
  │       ├── inbound/
  │       └── outbound/
  ├── adapters/
  │   ├── inbound/ (http controllers)
  │   └── outbound/ (repositories)
  └── config/`,
    prohibitedImports: ['express', '@nestjs/common', 'prisma', 'typeorm', 'axios']
  },
  cqrs: {
    id: 'cqrs',
    name: 'CQRS + Event Sourcing',
    description: 'Strict separation of command operations (writes) and query operations (reads) with read model projections.',
    patterns: ['Command Handler', 'Query Handler', 'Event Store', 'Read Model Projection', 'Write Aggregate', 'Event Publisher'],
    folderStructure: `src/
  ├── commands/
  │   ├── handlers/
  │   └── models/
  ├── queries/
  │   ├── handlers/
  │   └── projections/
  └── events/
      ├── store/
      └── schemas/`,
    prohibitedImports: ['express', '@nestjs/common']
  },
  clean: {
    id: 'clean',
    name: 'Clean Architecture',
    description: 'Dependency rule pointing strictly inward: Entities -> Use Cases -> Interface Adapters -> Frameworks & Drivers.',
    patterns: ['Entity', 'Use Case', 'Presenter', 'Controller', 'Gateway', 'Framework Driver'],
    folderStructure: `src/
  ├── entities/
  ├── use-cases/
  ├── interface-adapters/
  └── frameworks-drivers/`,
    prohibitedImports: ['express', '@nestjs/common', 'prisma']
  },
  microservices: {
    id: 'microservices',
    name: 'Microservices Architecture',
    description: 'Decoupled services communicating via API Gateways and Message Buses with a database per service.',
    patterns: ['API Gateway', 'Service Boundary', 'Saga Orchestrator', 'Event Bus', 'Database per Service', 'Circuit Breaker'],
    folderStructure: `services/
  ├── service-core/
  ├── api-gateway/
  └── shared/
      └── events/`,
    prohibitedImports: []
  }
};

export function getArchRule(archId: string): ArchRuleSpec {
  return ARCH_RULES[archId] || ARCH_RULES['hexagonal'];
}
