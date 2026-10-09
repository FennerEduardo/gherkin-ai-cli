// --------------------------------------------------------------------------
// Multi-tenancy Pattern for NestJS + Prisma
// Uses a Prisma Client extension and AsyncLocalStorage for tenant isolation
// --------------------------------------------------------------------------

import { defaultConfig } from '../../core/config';
import { NodeProfile, prismaAdapter, prismaClientImport, resolveNodeProfile } from '../node-profile';
import { renderNestTenantStorage } from '../kernel/app/typescript';

export function generateNestJsMultiTenancyInfrastructure(profile: NodeProfile = resolveNodeProfile(defaultConfig)): { filename: string; content: string }[] {
  // Prisma 7: the client is generated into the sources and needs a driver adapter.
  const adapter = profile.prisma === '7' ? prismaAdapter(profile.database) : undefined;
  const clientImports = adapter
    ? `import { ${adapter.className} } from '${adapter.pkg}';\nimport { PrismaClient } from '${prismaClientImport(profile, 'src/prisma')}';`
    : `import { PrismaClient } from '@prisma/client';`;
  const constructor = adapter ? `\n  constructor() {\n    super({ adapter: ${adapter.create} });\n  }\n` : '';
  // The tenant is set by JwtTenantGuard from the validated token; there is no header-based middleware
  // and no default tenant.
  const asyncLocalStorageCode = renderNestTenantStorage();

  // Prisma removed the $use middleware API in 6.14; tenant scoping is a query extension.
  const prismaMiddlewareCode = `import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
${clientImports}
import { currentTenant } from '../infrastructure/multitenancy/tenant.storage';

/** Infrastructure models shared by every tenant (outbox, idempotency keys, sagas). */
const SHARED_MODELS = new Set(['OutboxMessage', 'ProcessedEvent', 'SagaInstance']);
const FILTERED_OPERATIONS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'upsert', 'delete', 'deleteMany'
]);
// Sets, not literal comparisons: the operation union depends on the database provider
// (MySQL has no createManyAndReturn, SQLite older releases no createMany).
const BULK_CREATE_OPERATIONS = new Set(['createMany', 'createManyAndReturn']);

type Row = Record<string, unknown>;

/** Adds the request's tenant (from the validated token) to every query on tenant-owned models. */
export function withTenantScope(client: PrismaClient) {
  return client.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (SHARED_MODELS.has(model)) return query(args);
          const tenantId = currentTenant();
          const scoped = { ...(args as Row) };
          if (FILTERED_OPERATIONS.has(operation)) scoped.where = { ...(scoped.where as Row), tenantId };
          if (operation === 'create') scoped.data = { ...(scoped.data as Row), tenantId };
          if (operation === 'upsert') scoped.create = { ...(scoped.create as Row), tenantId };
          if (BULK_CREATE_OPERATIONS.has(operation)) {
            const rows = Array.isArray(scoped.data) ? (scoped.data as Row[]) : [scoped.data as Row];
            scoped.data = rows.map(row => ({ ...row, tenantId }));
          }
          return query(scoped as typeof args);
        }
      }
    }
  });
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {${constructor}
  /** Tenant-scoped view of this client: use it for domain models. */
  readonly tenant = withTenantScope(this);

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
`;

  return [
    // Canonical NestJS layout: everything under src/ (infrastructure/ at the root is the AWS CDK app).
    { filename: 'src/infrastructure/multitenancy/tenant.storage.ts', content: asyncLocalStorageCode },
    { filename: 'src/prisma/prisma.service.ts', content: prismaMiddlewareCode }
  ];
}
