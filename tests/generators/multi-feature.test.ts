import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleGenerateCommand } from '../../src/commands/generate';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';
import { topology } from '../../src/generators/kernel/runtime/shared';
import { parseGherkinText } from '../../src/core/gherkin-parser';

const ORDERS = 'Feature: Orders\n  Scenario: Place\n    When the customer places an order\n    Then the order is placed\n';
const REFUNDS = 'Feature: Refunds\n  Scenario: Issue\n    When the agent issues a refund\n    Then the refund is issued\n';

describe('multi-feature services', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-multi-'));
    cwd = process.cwd();
    process.chdir(dir);
    for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    fs.mkdirSync('features');
    fs.writeFileSync('features/orders.feature', ORDERS);
    fs.writeFileSync('features/refunds.feature', REFUNDS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = (stack: Record<string, string>) => fs.writeFileSync('gherkin-ai.config.json', JSON.stringify({
    projectName: 'shop', architecture: 'hexagonal', outputDir: './', rules: {},
    stack: { orm: 'none', database: 'postgresql', messaging: 'rabbitmq', validation: 'zod', auth: 'jwt', testing: 'jest', ...stack }
  }));
  const generateBoth = async () => {
    await handleGenerateCommand({ feature: 'features/orders.feature', yes: true });
    await handleGenerateCommand({ feature: 'features/refunds.feature', yes: true });
  };

  it('Express: one command service and app for every generated feature', async () => {
    config({ language: 'typescript', framework: 'express' });
    await generateBoth();
    const service = fs.readFileSync('src/runtime/command-service.ts', 'utf8');
    expect(service).toContain('Orders: {');
    expect(service).toContain('Refunds: {');
    expect(service).toContain("DEFAULT_AGGREGATE = 'Refunds'");
    const app = fs.readFileSync('src/app.ts', 'utf8');
    expect(app).toContain("['/api/v1/orders', 'Orders']");
    expect(app).toContain("['/api/v1/refunds', 'Refunds']");
  });

  it('NestJS: AppModule imports every feature module, not the runtime module twice', async () => {
    config({ language: 'typescript', framework: 'nestjs' });
    await generateBoth();
    const appModule = fs.readFileSync('src/app.module.ts', 'utf8');
    expect(appModule.match(/RuntimeModule/g)).toHaveLength(2); // import + use
    expect(appModule).toContain('OrdersModule');
    expect(appModule).toContain('RefundsModule');
  });

  it('Go: shared domain types live in one file, constants are prefixed per aggregate', async () => {
    config({ language: 'go', framework: 'chi', orm: 'pgx' });
    await generateBoth();
    expect(fs.readFileSync('internal/domain/kernel.go', 'utf8')).toContain('var ErrValidation');
    for (const f of ['internal/domain/orders.go', 'internal/domain/refunds.go']) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).not.toContain('var ErrValidation');
      expect(src).not.toMatch(/^type Command struct/m);
    }
    expect(fs.readFileSync('internal/domain/orders.go', 'utf8')).toContain('OrdersStatePending');
    const router = fs.readFileSync('internal/httpapi/router.go', 'utf8');
    expect(router).toContain('"/api/v1/orders/{id}/{command}": "Orders"');
  });

  it('names the RabbitMQ topology after the service', () => {
    const m = buildDomainModel(parseGherkinText(ORDERS), { service: 'Shop Backend' });
    expect(topology(m).exchange).toBe('shop-backend.events');
    expect(topology(buildDomainModel(parseGherkinText(ORDERS))).exchange).toBe('orders.events');
  });
});
