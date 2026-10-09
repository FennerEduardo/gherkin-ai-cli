/* ==========================================================================
   gherkin-ai-cli - Application layer for NestJS over the TypeScript runtime
   kernel: HTTP controller, JWT tenant guard, runtime module (pg pool +
   outbox relay worker + optional inbox consumer). Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface TsAppFile {
  filename: string;
  content: string;
}

/** HS256 JWT verification without dependencies (shared by every Node backend). */
export function renderTsJwt(claim: string): string {
  return `import { createHmac, timingSafeEqual } from 'crypto';

export type JwtClaims = Record<string, unknown> & { exp?: number; nbf?: number };

/** JWT claim that carries the tenant (gherkin-ai.config.json security.tenantClaim). */
export const TENANT_CLAIM = ${JSON.stringify(claim)};

const fromBase64Url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const toBase64Url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');

function parse(part: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fromBase64Url(part).toString('utf8'));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Claims of a valid HS256 token signed with \`secret\` (signature, exp and nbf checked), else undefined. */
export function verifyJwt(token: string, secret: string, nowSeconds = Date.now() / 1000): JwtClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !secret) return undefined;
  if (parse(parts[0])?.alg !== 'HS256') return undefined;
  const expected = createHmac('sha256', secret).update(\`\${parts[0]}.\${parts[1]}\`).digest();
  const given = fromBase64Url(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const claims = parse(parts[1]) as JwtClaims | undefined;
  if (!claims) return undefined;
  if (typeof claims.exp === 'number' && nowSeconds >= claims.exp) return undefined;
  if (typeof claims.nbf === 'number' && nowSeconds < claims.nbf) return undefined;
  return claims;
}

/** Signs an HS256 token (tests and local tooling; production tokens come from your identity provider). */
export function signJwt(claims: JwtClaims, secret: string): string {
  const head = toBase64Url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toBase64Url(Buffer.from(JSON.stringify(claims)));
  const sig = toBase64Url(createHmac('sha256', secret).update(\`\${head}.\${body}\`).digest());
  return \`\${head}.\${body}.\${sig}\`;
}

/**
 * Tenant of a request: the TENANT_CLAIM of its validated Bearer token. Undefined when the token is
 * missing, invalid or has no tenant. Headers such as X-Tenant-Id are never trusted.
 */
export function tenantFromAuthorization(authorization: string | undefined, secret = process.env.JWT_SECRET ?? ''): string | undefined {
  const match = /^Bearer\\s+(.+)$/i.exec(authorization ?? '');
  if (!match) return undefined;
  const claims = verifyJwt(match[1].trim(), secret);
  const tenant = claims?.[TENANT_CLAIM];
  return typeof tenant === 'string' && tenant.trim() ? tenant : undefined;
}
`;
}

export function renderNestTenantGuard(): string {
  return `import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { tenantFromAuthorization } from './jwt';
import { tenantLocalStorage } from '../infrastructure/multitenancy/tenant.storage';

/** Rejects requests without a valid token carrying a tenant; exposes the tenant as request.tenantId. */
@Injectable()
export class JwtTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; tenantId?: string }>();
    const tenantId = tenantFromAuthorization(request.headers.authorization);
    if (!tenantId) throw new UnauthorizedException('A valid bearer token with a tenant is required');
    request.tenantId = tenantId;
    // Tenant-scoped Prisma queries (PrismaService.tenant) read it from here.
    tenantLocalStorage.enterWith({ tenantId });
    return true;
  }
}
`;
}

export function renderNestTenantStorage(): string {
  return `import { AsyncLocalStorage } from 'async_hooks';

export const tenantLocalStorage = new AsyncLocalStorage<{ tenantId: string }>();

/** The tenant of the current request (set by JwtTenantGuard). There is no default tenant. */
export function currentTenant(): string {
  const tenantId = tenantLocalStorage.getStore()?.tenantId;
  if (!tenantId) throw new Error('No tenant in the current context: the request was not authenticated');
  return tenantId;
}
`;
}

/** Global module: pg pool, outbox relay worker and (when handlers are registered) the inbox consumer. */
export function renderNestRuntimeModule(m: DomainModel): string {
  return `import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as amqp from 'amqplib';
import { Pool } from 'pg';
import { DEFAULT_TOPOLOGY, OutboxRelay, declareTopology } from './outbox-relay';
import { InboxConsumer, type MessageHandler } from './inbox-consumer';

export const PG_POOL = Symbol('PG_POOL');
export const EVENT_HANDLERS = Symbol('EVENT_HANDLERS');

/** Handlers for consumed events, keyed by event type. Register them with { provide: EVENT_HANDLERS, useValue: {...} }. */
export type EventHandlers = Record<string, MessageHandler>;

/** Publishes the outbox every ${RELAY_INTERVAL_MS} ms and consumes events when handlers are registered. Needs AMQP_URL. */
@Injectable()
export class RuntimeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RuntimeWorker');
  private readonly workerId = \`${m.kebab}-\${randomUUID()}\`;
  private connection?: Awaited<ReturnType<typeof amqp.connect>>;
  private timer?: NodeJS.Timeout;
  private consumer?: InboxConsumer;

  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(EVENT_HANDLERS) private readonly handlers: EventHandlers) {}

  async onApplicationBootstrap(): Promise<void> {
    const url = process.env.AMQP_URL;
    if (!url) {
      this.logger.warn('AMQP_URL is not set: outbox events are stored but not published.');
      return;
    }
    this.connection = await amqp.connect(url);
    const channel = await this.connection.createConfirmChannel();
    await declareTopology(channel);
    const relay = new OutboxRelay(this.pool, channel, DEFAULT_TOPOLOGY.exchange);
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      relay.publishBatch(this.workerId)
        .catch(err => this.logger.error(\`Outbox relay failed: \${(err as Error).message}\`))
        .finally(() => { running = false; });
    }, ${RELAY_INTERVAL_MS});
    if (Object.keys(this.handlers).length) {
      const consume = await this.connection.createChannel();
      this.consumer = new InboxConsumer(this.pool, consume, DEFAULT_TOPOLOGY.queue, '${m.kebab}', async (event, meta) => {
        const handler = meta.eventType ? this.handlers[meta.eventType] : undefined;
        if (handler) await handler(event, meta);
      });
      await this.consumer.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.consumer?.stop().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) },
    { provide: EVENT_HANDLERS, useValue: {} satisfies EventHandlers },
    RuntimeWorker
  ],
  exports: [PG_POOL]
})
export class RuntimeModule {}
`;
}

export function renderNestController(m: DomainModel, aggregateImport: string): string {
  return `import { Body, Controller, Headers, HttpException, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { CommandService } from '../runtime/command-service';
import { DomainValidationError } from '${aggregateImport}';
import { JwtTenantGuard } from '../auth/jwt-tenant.guard';

const STATUS = { created: HttpStatus.ACCEPTED, replayed: HttpStatus.OK, 'in-progress': HttpStatus.CONFLICT } as const;

// ghk:implements ${m.pascal}
@Controller('${commandRoute(m).slice(1)}')
@UseGuards(JwtTenantGuard)
export class ${m.pascal}Controller {
  constructor(@Inject(CommandService) private readonly commands: CommandService) {}

  /** POST /api/v1/${m.kebab}/:id/:command (${m.commands.map(c => c.snake).join(', ')}) */
  @Post(':id/:command')
  async handle(
    @Param('id') id: string,
    @Param('command') command: string,
    @Body() payload: Record<string, unknown> | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Req() req: { tenantId: string },
    @Res({ passthrough: true }) res: { status(code: number): unknown }
  ) {
    try {
      const result = await this.commands.handle({ tenantId: req.tenantId, aggregateId: id, command, payload: payload ?? {}, idempotencyKey, traceparent });
      res.status(STATUS[result.status]);
      return result;
    } catch (err) {
      if (err instanceof DomainValidationError) throw new HttpException(err.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw err;
    }
  }
}
`;
}

export function renderNestFeatureModule(m: DomainModel): string {
  return `import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { CommandService } from '../runtime/command-service';
import { PG_POOL } from '../runtime/runtime.module';
import { ${m.pascal}Controller } from './${m.kebab}.controller';

@Module({
  controllers: [${m.pascal}Controller],
  providers: [{ provide: CommandService, useFactory: (pool: Pool) => new CommandService(pool), inject: [PG_POOL] }]
})
export class ${m.pascal}Module {}
`;
}

/** AppModule importing the runtime and every feature module (`features`: [pascal, kebab]). */
export function renderNestAppModule(features: { pascal: string; kebab: string }[]): string {
  const sorted = [...new Map(features.map(f => [f.kebab, f])).values()].sort((a, b) => a.kebab.localeCompare(b.kebab));
  return `import { Module } from '@nestjs/common';
import { RuntimeModule } from './runtime/runtime.module';
${sorted.map(f => `import { ${f.pascal}Module } from './${f.kebab}/${f.kebab}.module';`).join('\n')}

@Module({
  imports: [RuntimeModule, ${sorted.map(f => `${f.pascal}Module`).join(', ')}]
})
export class AppModule {}
`;
}

/** Drives the HTTP contract through the controller to the outbox against PostgreSQL. */
export function renderNestHttpSpec(m: DomainModel): string {
  const command = m.commands[0];
  return `// HTTP contract of the application layer (POST ${commandRoute(m)}/:id/:command) against PostgreSQL.
// Requires DATABASE_URL (and AMQP_URL for the relay worker). Run with: npm run test:integration
import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { migrate } from '../../src/runtime/schema';
import { signJwt, TENANT_CLAIM } from '../../src/auth/jwt';

const SECRET = 'integration-test-secret-with-32-chars!';
process.env.JWT_SECRET = SECRET;

describe('${m.pascal} HTTP application layer', () => {
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  const tenant = \`tenant-\${randomUUID()}\`;
  const token = (claims: Record<string, unknown>) => \`Bearer \${signJwt(claims, SECRET)}\`;
  const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
    fetch(\`\${base}\${path}\`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(pool);
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('rejects requests without a valid token, and never trusts X-Tenant-Id', async () => {
    const id = randomUUID();
    expect((await post(\`${commandRoute(m)}/\${id}/${command.snake}\`, {})).status).toBe(401);
    expect((await post(\`${commandRoute(m)}/\${id}/${command.snake}\`, { 'x-tenant-id': tenant })).status).toBe(401);
    expect((await post(\`${commandRoute(m)}/\${id}/${command.snake}\`, { authorization: token({ sub: 'u1' }) })).status).toBe(401);
    expect((await post(\`${commandRoute(m)}/\${id}/${command.snake}\`, { authorization: \`Bearer \${signJwt({ [TENANT_CLAIM]: tenant }, 'wrong-secret')}\` })).status).toBe(401);
  });

  it('runs a command into the outbox for the token tenant, idempotently', async () => {
    const id = randomUUID();
    const headers = { authorization: token({ [TENANT_CLAIM]: tenant }), 'idempotency-key': randomUUID(), 'x-tenant-id': 'someone-else' };
    const first = await post(\`${commandRoute(m)}/\${id}/${command.snake}\`, headers);
    expect(first.status).toBe(202);
    const replay = await post(\`${commandRoute(m)}/\${id}/${command.snake}\`, headers);
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe('replayed');

    const { rows } = await pool.query('SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1', [id]);
    expect(rows).toEqual([{ tenant_id: tenant }]);
  });

  it('maps domain validation errors to 422', async () => {
    const res = await post(\`${commandRoute(m)}/\${randomUUID()}/no_such_command\`, { authorization: token({ [TENANT_CLAIM]: tenant }) });
    expect(res.status).toBe(422);
  });
});
`;
}

/** Express app over a command port (the runtime CommandService in production, a fake in unit tests). */
export function renderExpressApp(m: DomainModel): string {
  return `import express, { NextFunction, Request, Response } from 'express';
import { DomainValidationError } from './domain/${m.kebab}.aggregate';
import type { CommandRequest, CommandResult } from './runtime/command-service';
import { tenantFromAuthorization } from './auth/jwt';

/** What the HTTP layer needs from the runtime kernel (CommandService implements it). */
export interface CommandPort {
  handle(request: CommandRequest): Promise<CommandResult>;
}

const STATUS: Record<CommandResult['status'], number> = { created: 202, replayed: 200, 'in-progress': 409 };

// ghk:implements ${m.pascal}
export function createApp(commands: CommandPort): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** POST ${commandRoute(m)}/:id/:command (${m.commands.map(c => c.snake).join(', ')}) */
  app.post('${commandRoute(m)}/:id/:command', async (req: Request<{ id: string; command: string }>, res: Response, next: NextFunction) => {
    // The tenant comes only from the validated token, never from a header such as X-Tenant-Id.
    const tenantId = tenantFromAuthorization(req.headers.authorization);
    if (!tenantId) {
      res.status(401).json({ detail: 'A valid bearer token with a tenant is required' });
      return;
    }
    try {
      const result = await commands.handle({
        tenantId,
        aggregateId: req.params.id,
        command: req.params.command,
        payload: req.body ?? {},
        idempotencyKey: req.header('idempotency-key') ?? undefined,
        traceparent: req.header('traceparent') ?? undefined
      });
      res.status(STATUS[result.status]).json(result);
    } catch (err) {
      if (err instanceof DomainValidationError) {
        res.status(422).json({ detail: err.message });
        return;
      }
      next(err);
    }
  });

  return app;
}
`;
}

/** Server: pg pool, CommandService, and the outbox relay worker when AMQP_URL is set. */
export function renderExpressServer(m: DomainModel): string {
  return `import { randomUUID } from 'crypto';
import * as amqp from 'amqplib';
import { Pool } from 'pg';
import { createApp } from './app';
import { CommandService } from './runtime/command-service';
import { DEFAULT_TOPOLOGY, OutboxRelay, declareTopology } from './runtime/outbox-relay';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const port = Number(process.env.PORT) || 3000;
  const server = createApp(new CommandService(pool)).listen(port, () => console.log(\`listening on :\${port}\`));

  let timer: NodeJS.Timeout | undefined;
  let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
  if (process.env.AMQP_URL) {
    connection = await amqp.connect(process.env.AMQP_URL);
    const channel = await connection.createConfirmChannel();
    await declareTopology(channel);
    const relay = new OutboxRelay(pool, channel, DEFAULT_TOPOLOGY.exchange);
    const workerId = \`${m.kebab}-\${randomUUID()}\`;
    let running = false;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      relay.publishBatch(workerId).catch(err => console.error('outbox relay failed', err)).finally(() => { running = false; });
    }, ${RELAY_INTERVAL_MS});
  } else {
    console.warn('AMQP_URL is not set: outbox events are stored but not published.');
  }

  const shutdown = () => {
    if (timer) clearInterval(timer);
    server.close(() => {
      void Promise.allSettled([connection?.close(), pool.end()]).then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
`;
}

/** Unit tests of the HTTP contract with a fake command port (no database). */
export function renderExpressAppSpec(m: DomainModel): string {
  const first = m.commands[0];
  return `import request from 'supertest';
import { createApp, type CommandPort } from './app';
import { DomainValidationError } from './domain/${m.kebab}.aggregate';
import { signJwt, TENANT_CLAIM } from './auth/jwt';
import type { CommandRequest } from './runtime/command-service';

const SECRET = 'unit-test-secret-with-at-least-32-chars';
process.env.JWT_SECRET = SECRET;

describe('HTTP API', () => {
  const calls: CommandRequest[] = [];
  const port: CommandPort = {
    async handle(req) {
      calls.push(req);
      if (req.command === 'does_not_exist') throw new DomainValidationError(\`Unknown command \${req.command}\`);
      return { status: req.idempotencyKey === 'seen' ? 'replayed' : 'created', aggregateId: req.aggregateId, eventType: '${first.event}', version: 1 };
    }
  };
  const app = createApp(port);
  const bearer = (claims: Record<string, unknown>) => \`Bearer \${signJwt(claims, SECRET)}\`;

  it('reports health', async () => {
    await request(app).get('/health').expect(200, { status: 'ok' });
  });

  it('runs a command for the token tenant', async () => {
    const res = await request(app)
      .post('${commandRoute(m)}/agg-api/${first.snake}')
      .set('authorization', bearer({ [TENANT_CLAIM]: 'acme' }))
      .set('x-tenant-id', 'someone-else')
      .send({ source: 'api-test' })
      .expect(202);
    expect(res.body).toMatchObject({ status: 'created', aggregateId: 'agg-api' });
    expect(calls[calls.length - 1]).toMatchObject({ tenantId: 'acme', command: '${first.snake}', payload: { source: 'api-test' } });
  });

  it('returns 200 for an idempotent replay', async () => {
    await request(app).post('${commandRoute(m)}/agg-api/${first.snake}').set('authorization', bearer({ [TENANT_CLAIM]: 'acme' })).set('idempotency-key', 'seen').expect(200);
  });

  it('rejects requests without a token, with X-Tenant-Id only, or without a tenant claim', async () => {
    await request(app).post('${commandRoute(m)}/agg-api/${first.snake}').expect(401);
    await request(app).post('${commandRoute(m)}/agg-api/${first.snake}').set('x-tenant-id', 'acme').expect(401);
    await request(app).post('${commandRoute(m)}/agg-api/${first.snake}').set('authorization', bearer({ sub: 'u1' })).expect(401);
    await request(app).post('${commandRoute(m)}/agg-api/${first.snake}').set('authorization', \`Bearer \${signJwt({ [TENANT_CLAIM]: 'acme' }, 'wrong')}\`).expect(401);
  });

  it('maps domain validation errors to 422', async () => {
    await request(app).post('${commandRoute(m)}/agg-api/does_not_exist').set('authorization', bearer({ [TENANT_CLAIM]: 'acme' })).expect(422);
  });
});
`;
}

/** Integration: the Express app over the real CommandService writes the outbox (PostgreSQL). */
export function renderExpressHttpSpec(m: DomainModel): string {
  const first = m.commands[0];
  return `// HTTP contract of the application layer against PostgreSQL. Requires DATABASE_URL.
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/app';
import { CommandService } from '../../src/runtime/command-service';
import { migrate } from '../../src/runtime/schema';
import { signJwt, TENANT_CLAIM } from '../../src/auth/jwt';

const SECRET = 'integration-test-secret-with-32-chars!';
process.env.JWT_SECRET = SECRET;

describe('${m.pascal} HTTP application layer', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const app = createApp(new CommandService(pool));
  const tenant = \`tenant-\${randomUUID()}\`;

  beforeAll(() => migrate(pool));
  afterAll(() => pool.end());

  it('runs a command into the outbox for the token tenant, idempotently', async () => {
    const id = randomUUID();
    const key = randomUUID();
    const send = () => request(app)
      .post(\`${commandRoute(m)}/\${id}/${first.snake}\`)
      .set('authorization', \`Bearer \${signJwt({ [TENANT_CLAIM]: tenant }, SECRET)}\`)
      .set('idempotency-key', key)
      .set('x-tenant-id', 'someone-else')
      .send({});
    await send().expect(202);
    const replay = await send().expect(200);
    expect(replay.body.status).toBe('replayed');
    const { rows } = await pool.query('SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1', [id]);
    expect(rows).toEqual([{ tenant_id: tenant }]);
  });
});
`;
}
