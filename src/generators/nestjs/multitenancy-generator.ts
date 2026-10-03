// --------------------------------------------------------------------------
// Multi-tenancy Pattern for NestJS + Prisma
// Uses a Prisma Client extension and AsyncLocalStorage for tenant isolation
// --------------------------------------------------------------------------

export function generateNestJsMultiTenancyInfrastructure(): { filename: string; content: string }[] {
  const asyncLocalStorageCode = `import { AsyncLocalStorage } from 'async_hooks';

export const tenantLocalStorage = new AsyncLocalStorage<{ tenantId: string }>();
`;

  const middlewareCode = `import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { tenantLocalStorage } from './tenant.storage';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.headers['x-tenant-id'] as string || 'default';
    
    // Wrap the request in the AsyncLocalStorage context
    tenantLocalStorage.run({ tenantId }, () => {
      next();
    });
  }
}
`;

  // Prisma removed the $use middleware API in 6.14; tenant scoping is a query extension.
  const prismaMiddlewareCode = `import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantLocalStorage } from '../infrastructure/multitenancy/tenant.storage';

/** Infrastructure models shared by every tenant (outbox, idempotency keys, sagas). */
const SHARED_MODELS = new Set(['OutboxMessage', 'ProcessedEvent', 'SagaInstance']);
const FILTERED_OPERATIONS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'upsert', 'delete', 'deleteMany'
]);

type Row = Record<string, unknown>;

/** Adds the current tenant (from AsyncLocalStorage) to every query on tenant-owned models. */
export function withTenantScope(client: PrismaClient) {
  return client.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (SHARED_MODELS.has(model)) return query(args);
          const tenantId = tenantLocalStorage.getStore()?.tenantId ?? 'default';
          const scoped = { ...(args as Row) };
          if (FILTERED_OPERATIONS.has(operation)) scoped.where = { ...(scoped.where as Row), tenantId };
          if (operation === 'create') scoped.data = { ...(scoped.data as Row), tenantId };
          if (operation === 'upsert') scoped.create = { ...(scoped.create as Row), tenantId };
          if (operation === 'createMany' || operation === 'createManyAndReturn') {
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
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
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
    { filename: 'src/infrastructure/multitenancy/tenant.middleware.ts', content: middlewareCode },
    { filename: 'src/prisma/prisma.service.ts', content: prismaMiddlewareCode }
  ];
}
