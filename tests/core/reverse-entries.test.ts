/* ==========================================================================
   `ghk reverse`: entry points that are not HTTP, database constraints and
   calls to other systems (PLAN-3.3.0-reverse-plus RV-06, RV-08).
   One hand-written fixture per family in tests/fixtures/reverse/async-entries/.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { runScan } from '../../src/core/reverse';
import { buildCandidates, entryOperation, isTechnicalEntry } from '../../src/core/reverse/candidates';
import { constraintsIn, entityFromTable } from '../../src/core/reverse/analyzers/persistence/constraints';
import { makeEvidence } from '../../src/core/reverse/evidence';
import { renderProposals } from '../../src/core/reverse/renderer';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';

const DIR = path.join(__dirname, '..', 'fixtures', 'reverse', 'async-entries');

async function candidatesOf(family: string) {
  clearTsProjects();
  const scan = await runScan(path.join(DIR, family), { write: false });
  return { scan, ...buildCandidates(scan.evidence) };
}
const summary = (cs: Awaited<ReturnType<typeof candidatesOf>>['candidates']) =>
  cs.map(c => ({ op: c.operation.name, aggregate: c.aggregate, trigger: c.operation.method, when: c.scenarios[0]?.steps.find(s => s.keyword === 'When')?.text, then: c.scenarios[0]?.steps.filter(s => s.keyword !== 'When').map(s => s.text) }));

describe('reverse: message handlers and scheduled jobs', () => {
  it('NestJS: @OnEvent and @Cron become operations; the outbox relay is left out', async () => {
    const { candidates } = await candidatesOf('nestjs');
    const s = summary(candidates);
    expect(s).toEqual(expect.arrayContaining([
      { op: 'SendConfirmation', aggregate: 'Notification', trigger: 'EVENT', when: 'the "OrderPlaced" event is received', then: ['the notification status is "SENT"'] },
      { op: 'PurgeExpiredCarts', aggregate: 'Cart', trigger: 'SCHEDULE', when: 'the scheduled job runs ("0 3 * * *")', then: ['the cart status is "EXPIRED"'] }
    ]));
    expect(s.map(x => x.op)).not.toContain('Relay');
    expect(s.some(x => /relay/i.test(x.op))).toBe(false);
  }, 60000);

  it('Spring: @KafkaListener and @Scheduled, in a class that is not a controller', async () => {
    const s = summary((await candidatesOf('spring')).candidates);
    expect(s).toEqual(expect.arrayContaining([
      { op: 'ReserveStock', aggregate: 'Stock', trigger: 'EVENT', when: 'the "OrderPlaced" event is received', then: ['the stock status is "RESERVED"'] },
      { op: 'ReleaseExpiredReservations', aggregate: 'Stock', trigger: 'SCHEDULE', when: 'the scheduled job runs ("0 0 * * * *")', then: ['the stock status is "RELEASED"'] }
    ]));
  }, 60000);

  it('.NET: IConsumer<T> and BackgroundService; no schedule is invented for a background service', async () => {
    const s = summary((await candidatesOf('dotnet')).candidates);
    expect(s).toEqual(expect.arrayContaining([
      { op: 'HandleOrderShipped', aggregate: 'Order', trigger: 'EVENT', when: 'the "OrderShipped" event is received', then: ['the order status is "ISSUED"'] },
      expect.objectContaining({ op: 'RunOverdueInvoiceReminderJob', trigger: 'SCHEDULE', when: 'the scheduled job runs' })
    ]));
  }, 60000);

  it('Python: a Celery task is a message handler; Go: a NATS subscription and a cron job', async () => {
    expect(summary((await candidatesOf('python')).candidates)).toEqual([
      { op: 'SendReceipt', aggregate: 'Receipt', trigger: 'EVENT', when: 'a message arrives on "receipts.send"', then: ['the receipt status is "SENT"'] }
    ]);
    expect(summary((await candidatesOf('go')).candidates)).toEqual(expect.arrayContaining([
      { op: 'ScheduleShipment', aggregate: 'Shipment', trigger: 'EVENT', when: 'a message arrives on "orders.order-paid"', then: ['the shipment status is "SCHEDULED"'] },
      { op: 'ArchiveDeliveredShipments', aggregate: 'Shipment', trigger: 'SCHEDULE', when: 'the scheduled job runs ("@daily")', then: ['the shipment status is "ARCHIVED"'] }
    ]));
  }, 60000);

  it('the proposals with handlers and jobs lint and round-trip', async () => {
    const { scan, candidates } = await candidatesOf('nestjs');
    for (const p of renderProposals(candidates, scan.evidence)) {
      expect(p.roundTrip.ok, p.file).toBe(true);
      expect(p.lint.score, p.file).toBeGreaterThanOrEqual(80);
    }
  }, 60000);

  it('names a handler by its verb, otherwise Handle<Event> or Run<Job>', () => {
    expect(entryOperation({ trigger: 'message', channel: 'order.placed', handler: 'sendConfirmation' }, 'Notification').name).toBe('SendConfirmation');
    expect(entryOperation({ trigger: 'message', channel: 'orders.order-placed.v1', handler: 'handle' }, 'Order').name).toBe('HandleOrderPlaced');
    expect(entryOperation({ trigger: 'schedule', handler: 'nightly' }, 'Report').name).toBe('RunNightlyJob');
  });

  it('leaves out platform jobs by whole words only', () => {
    const e = (meta: Record<string, string>, file = 'src/jobs.ts') => makeEvidence({ kind: 'scheduled-job', description: 'x', location: { file, startLine: 1, endLine: 1 }, extractor: 't', confidence: 'strong', metadata: { trigger: 'schedule', ...meta } });
    expect(isTechnicalEntry(e({ owner: 'OutboxRelay', handler: 'relay' }))).toBe(true);
    expect(isTechnicalEntry(e({ handler: 'pollInbox' }))).toBe(true);
    expect(isTechnicalEntry(e({ handler: 'tick' }, 'src/runtime/scheduler.ts'))).toBe(true);
    expect(isTechnicalEntry(e({ handler: 'releaseExpiredReservations' }))).toBe(false);
    expect(isTechnicalEntry(e({ handler: 'shippingReminder' }))).toBe(false);
  });
});

describe('reverse: Spring @RequestMapping with a statically imported method (RV-11)', () => {
  it('reads `method = POST` as POST, as the Spring RealWorld app writes it', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-rv11-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'main', 'java', 'shop'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'main', 'java', 'shop', 'UsersApi.java'), [
        'package shop;',
        'import static org.springframework.web.bind.annotation.RequestMethod.POST;',
        'import org.springframework.web.bind.annotation.*;',
        '@RestController',
        'public class UsersApi {',
        '  @RequestMapping(path = "/users/login", method = POST)',
        '  public String login() { return "ok"; }',
        '}'
      ].join('\n'));
      const scan = await runScan(dir, { write: false });
      const endpoints = scan.evidence.filter(e => e.kind === 'http-endpoint').map(e => e.description);
      expect(endpoints).toEqual(['POST /users/login']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});

describe('reverse: database constraints and other systems', () => {
  it('a unique constraint confirms the conflict scenario of its aggregate', async () => {
    const { candidates } = await candidatesOf('nestjs');
    const register = candidates.find(c => c.operation.name === 'RegisterCustomer')!;
    const conflict = register.scenarios.find(s => /already registered/.test(s.name))!;
    expect(conflict.confidence).toBe('confirmed');
  }, 60000);

  it('a call to another system is an open question, never a step', async () => {
    const { candidates, unresolved } = await candidatesOf('nestjs');
    expect(unresolved.some(u => /RegisterCustomer calls another system: HTTP POST https:\/\/crm\.example\.com\/contacts/.test(u.question))).toBe(true);
    expect(JSON.stringify(candidates.flatMap(c => c.scenarios))).not.toMatch(/crm\.example\.com/);
    for (const family of ['spring', 'python', 'go']) {
      const r = await candidatesOf(family);
      expect(r.unresolved.some(u => /calls another system/.test(u.question)), family).toBe(true);
    }
  }, 60000);

  it('reads unique constraints from Prisma, SQL, JPA, EF Core, Django, SQLAlchemy and TypeORM', () => {
    expect(constraintsIn('schema.prisma', 'model User {\n  id String @id\n  email String @unique\n  @@unique([tenantId, code])\n}')).toEqual([
      expect.objectContaining({ entity: 'User', fields: ['email'] }), expect.objectContaining({ entity: 'User', fields: ['tenantId', 'code'] })
    ]);
    expect(constraintsIn('V1__init.sql', 'CREATE TABLE order_items (\n  id uuid primary key,\n  sku text NOT NULL UNIQUE,\n  UNIQUE (order_id, line)\n);\nCREATE UNIQUE INDEX ux_customers_email ON customers (email);').map(c => `${c.entity}:${c.fields.join('+')}`))
      .toEqual(['OrderItem:sku', 'OrderItem:order_id+line', 'Customer:email']);
    expect(constraintsIn('User.java', '@Entity\nclass User {\n  @Column(unique = true)\n  private String email;\n}').map(c => `${c.entity}:${c.fields}`)).toEqual(['User:email']);
    expect(constraintsIn('Db.cs', 'b.Entity<Invoice>().HasIndex(i => i.Number).IsUnique();').map(c => `${c.entity}:${c.fields}`)).toEqual(['Invoice:Number']);
    expect(constraintsIn('models.py', 'class Account(models.Model):\n    iban = models.CharField(max_length=34, unique=True)\n').map(c => `${c.entity}:${c.fields}`)).toEqual(['Account:iban']);
    expect(constraintsIn('user.entity.ts', '@Entity()\nexport class Member {\n  @Column({ unique: true })\n  handle!: string;\n}').map(c => `${c.entity}:${c.fields}`)).toEqual(['Member:handle']);
    expect(entityFromTable('"public"."order_items"')).toBe('OrderItem');
  });
});
