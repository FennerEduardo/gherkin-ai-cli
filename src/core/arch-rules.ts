import fs from 'fs';
import path from 'path';
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
  monolith: {
    id: 'monolith',
    name: 'Monolith Architecture (MVC / Monolithic)',
    description: 'Unified application architecture with Model-View-Controller (MVC) layers and decoupled domain logic.',
    patterns: ['Model (Domain/Entity)', 'View (Templates/UI)', 'Controller (Request Handler)', 'Service Layer', 'Repository Port'],
    folderStructure: `app/
  ├── Controllers/
  ├── Models/
  ├── Views/
  ├── Services/
  └── Repositories/`,
    prohibitedImports: ['direct SQL string interpolation', 'global state mutation']
  },
  'api-rest': {
    id: 'api-rest',
    name: 'API REST Architecture (Stateless Service)',
    description: 'Stateless REST API service structured around Resources, DTOs, Controllers, and Service Ports.',
    patterns: ['REST Controller', 'Request DTO', 'Response DTO', 'Resource Serializer', 'Service Port'],
    folderStructure: `src/
  ├── controllers/
  ├── dtos/
  ├── services/
  ├── models/
  └── middleware/`,
    prohibitedImports: ['stateful session storage', 'direct DB coupling in controllers']
  },
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
  return ARCH_RULES[archId] || ARCH_RULES['monolith'];
}

// ---------------------------------------------------------------------------
// Layer discovery
// ---------------------------------------------------------------------------

/** Folder names that implement a layer, besides the layer's own name. */
export const LAYER_ALIASES: Record<string, string[]> = {
  domain: ['domain', 'model', 'core'],
  application: ['application', 'app', 'usecases', 'use-cases', 'usecase', 'services', 'service'],
  infrastructure: ['infrastructure', 'infra', 'adapters', 'adapter', 'persistence', 'runtime'],
  presentation: ['presentation', 'api', 'web', 'controllers', 'controller', 'http', 'rest', 'interfaces', 'ui']
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'bin', 'obj', 'coverage', '.gradle', '_build', 'deps', 'vendor', '.venv', '__pycache__', '.ghe', '.gherkin-ai', 'frontend']);

/**
 * Directories that hold a layer anywhere under `roots` — `src/<layer>`, Maven/Gradle packages
 * (`src/main/java/com/acme/orders/<layer>`), Go `internal/<layer>`, or .NET projects named `*.<Layer>`.
 * Returns paths relative to the first root.
 */
export function findLayerDirs(roots: string[], layer: string, maxDepth = 9): string[] {
  const names = new Set([layer.toLowerCase(), ...(LAYER_ALIASES[layer.toLowerCase()] ?? [])]);
  const found = new Set<string>();
  const base = roots[0];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const lower = e.name.toLowerCase();
      const dotnetSuffix = lower.split('.').pop() as string;
      if (names.has(lower) || (lower.includes('.') && names.has(dotnetSuffix))) found.add(path.relative(base, full).replace(/\\/g, '/') || '.');
      walk(full, depth + 1);
    }
  };
  for (const root of [...new Set(roots)]) walk(root, 0);
  return [...found].sort();
}
