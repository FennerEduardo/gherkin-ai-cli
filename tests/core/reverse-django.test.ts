/* ==========================================================================
   `ghk reverse` on Django REST framework (PLAN-3.3.0-reverse-plus RV-12),
   on a hand-written fixture: include() prefixes, a router with a
   ModelViewSet and an @action, a generic view, an APIView, @api_view
   functions, permissions, serializer rules and DRF responses.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { runScan } from '../../src/core/reverse';
import { buildCandidates } from '../../src/core/reverse/candidates';
import { djangoRegexPath } from '../../src/core/reverse/analyzers/python/django';
import { renderProposals } from '../../src/core/reverse/renderer';

const DIR = path.join(__dirname, '..', 'fixtures', 'reverse', 'django-shop');

describe('reverse on Django REST framework', () => {
  it('turns url regexes into paths', () => {
    expect(djangoRegexPath('^articles/(?P<article_slug>[-\\w]+)/favorite/?$')).toBe('articles/{article_slug}/favorite');
    expect(djangoRegexPath('^tags/?$')).toBe('tags');
    expect(djangoRegexPath('^(?:a|b)/$')).toBeUndefined();
  });

  it('reads the routes through include(), the router and every kind of view', async () => {
    const scan = await runScan(DIR, { write: false });
    expect(scan.analyzers.map(a => `${a.id}:${a.maturity}`)).toContain('python/django:beta');
    const endpoints = scan.evidence.filter(e => e.kind === 'http-endpoint').map(e => e.description).sort();
    expect(endpoints).toEqual([
      'DELETE /api/v1/orders/{pk}', 'GET /api/v1/customers', 'GET /api/v1/health', 'GET /api/v1/orders', 'GET /api/v1/orders/{pk}',
      'PATCH /api/v1/orders/{pk}', 'POST /api/v1/customers', 'POST /api/v1/customers/{customer_id}/vouchers', 'POST /api/v1/orders',
      'POST /api/v1/orders/{pk}/cancel', 'POST /api/v1/refunds', 'PUT /api/v1/orders/{pk}'
    ]);
  }, 60000);

  it('reads permissions, serializer rules, guarded failures, states and statuses', async () => {
    const scan = await runScan(DIR, { write: false });
    const { candidates } = buildCandidates(scan.evidence);
    const op = (name: string) => candidates.find(c => c.operation.name === name)!;
    expect(candidates.map(c => c.operation.name)).toEqual(expect.arrayContaining(['UpdateOrder', 'PatchOrder', 'CancelOrder', 'RequestRefund', 'CreateVoucher']));
    const cancel = op('CancelOrder');
    expect(cancel.scenarios.map(s => s.name)).toEqual(expect.arrayContaining(['Cancel the order', 'An unauthenticated user cannot cancel the order', 'Cancelling the order fails when the order is not pending']));
    // A custom action that does not use the serializer gets none of its rules.
    expect(cancel.scenarios.some(s => s.examples)).toBe(false);
    expect(cancel.scenarios[0].steps.map(s => s.text)).toEqual(expect.arrayContaining(['an order with status "PENDING"', 'the order status is "CANCELLED"']));
    const create = op('CreateOrder');
    const outline = create.scenarios.find(s => s.examples)!;
    expect(outline.examples!.rows.map(r => r.cells.join(': '))).toEqual(['customer email: missing', 'customer email: not a valid email', 'reference: missing', 'reference: not short enough (at most 20)']);
    expect(op('ListCustomers').scenarios.map(s => s.name)).toContain('A user without the admin role cannot list the customers');
    expect(op('RequestRefund').scenarios[0].steps.map(s => s.text)).toEqual(expect.arrayContaining(['the refund status is "REQUESTED"']));
    // Platform endpoints are left out of the proposals.
    expect(candidates.some(c => /health/.test(c.operation.path))).toBe(false);
    for (const p of renderProposals(candidates, scan.evidence)) {
      expect(p.roundTrip.ok, p.file).toBe(true);
      expect(p.lint.score, p.file).toBeGreaterThanOrEqual(80);
    }
  }, 60000);
});
