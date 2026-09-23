// --------------------------------------------------------------------------
// Multi-tenancy Pattern for NestJS + Prisma
// Uses Prisma Middleware and AsyncLocalStorage for seamless tenant isolation
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

  const prismaMiddlewareCode = `import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantLocalStorage } from '../multitenancy/tenant.storage';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super();
    this.addTenantMiddleware();
  }

  async onModuleInit() {
    await this.$connect();
  }

  private addTenantMiddleware() {
    // Prisma $use middleware for automatic tenant filtering
    this.$use(async (params, next) => {
      const context = tenantLocalStorage.getStore();
      const tenantId = context?.tenantId || 'default';

      // Check if the model has a tenantId field (assume yes for demo, adjust as needed)
      // For a real production app, you might want a whitelist of tenant-aware models
      if (params.model && !['IdempotencyRecord', 'OutboxMessage'].includes(params.model)) {
        if (params.action === 'findUnique' || params.action === 'findFirst') {
          // Change to findFirst
          params.action = 'findFirst';
          params.args.where = { ...params.args.where, tenantId };
        }
        if (params.action === 'findMany') {
          params.args.where = { ...params.args.where, tenantId };
        }
        if (params.action === 'update' || params.action === 'updateMany' || params.action === 'delete' || params.action === 'deleteMany') {
          params.args.where = { ...params.args.where, tenantId };
        }
        if (params.action === 'create' || params.action === 'createMany') {
          if (params.action === 'create') {
            params.args.data = { ...params.args.data, tenantId };
          } else {
            params.args.data = params.args.data.map((d: any) => ({ ...d, tenantId }));
          }
        }
      }
      return next(params);
    });
  }
}
`;

  return [
    { filename: 'infrastructure/multitenancy/tenant.storage.ts', content: asyncLocalStorageCode },
    { filename: 'infrastructure/multitenancy/tenant.middleware.ts', content: middlewareCode },
    { filename: 'infrastructure/prisma/prisma.service.ts', content: prismaMiddlewareCode }
  ];
}
