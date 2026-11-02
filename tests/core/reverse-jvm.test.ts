/* ==========================================================================
   `ghk reverse` on Spring Boot and Quarkus, Java and Kotlin (PLAN-3.3.0 R-06, R-07)

   tree-sitter (web-tree-sitter 0.25.10 + the grammars vendored in
   vendor/tree-sitter) on hand-written services:
   - brownfield-spring: the Java controller of the governance golden;
   - spring-kotlin-invoices: Kotlin controller → service → repository, a role,
     a validated data class, `?: throw` with @ResponseStatus exceptions,
     a state guard, an event and a MockMvc test;
   - quarkus-payments: JAX-RS resource, @RolesAllowed, a validated record,
     `.orElseThrow(…)`, an ExceptionMapper and Response.created(…).
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runPropose, runScan } from '../../src/core/reverse';
import { grammarDir, parserFor, unquote } from '../../src/core/reverse/analyzers/treesitter/loader';
import { exceptionStatusByName, statusFromText, throwFromText } from '../../src/core/reverse/analyzers/jvm/spring';
import { resourceFromPath, singular } from '../../src/core/reverse/candidates';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const propose = async (rel: string) => runPropose(path.join(FIXTURES, rel), await runScan(path.join(FIXTURES, rel), { write: false }), { write: false });
const scenarioNames = (result: Awaited<ReturnType<typeof propose>>, op: string) => result.candidates.find(c => c.operation.name === op)?.scenarios.map(s => s.name) ?? [];

describe('tree-sitter loader', () => {
  it('loads every vendored grammar with the pinned web-tree-sitter', async () => {
    expect(fs.readdirSync(grammarDir()).filter(f => f.endsWith('.wasm')).sort()).toEqual(['tree-sitter-c_sharp.wasm', 'tree-sitter-go.wasm', 'tree-sitter-java.wasm', 'tree-sitter-kotlin.wasm', 'tree-sitter-python.wasm']);
    const samples = { java: 'class A { void b() {} }', kotlin: 'class A {\n    fun b(): Int {\n        return 1\n    }\n}\n', c_sharp: 'class A { void B() {} }', python: 'def b():\n    pass\n', go: 'package a\nfunc B() {}\n' } as const;
    for (const [id, src] of Object.entries(samples)) {
      const tree = (await parserFor(id as keyof typeof samples)).parse(src);
      expect(tree?.rootNode.hasError, id).toBe(false);
    }
  });

  it('unquotes literals, keeps route templates, refuses interpolation', () => {
    expect(unquote('"/{id}/cancel"')).toBe('/{id}/cancel');
    expect(unquote('"Hello ${name}"')).toBeUndefined();
    expect(unquote('"Hello $name"')).toBeUndefined();
    expect(unquote('f"total {x}"')).toBeUndefined();
    expect(unquote("'plain'")).toBe('plain');
  });
});

describe('JVM helpers', () => {
  it('reads HTTP statuses the way Spring and JAX-RS name them', () => {
    expect(statusFromText('ResponseEntity.notFound().build()')).toBe(404);
    expect(statusFromText('new ResponseStatusException(HttpStatus.CONFLICT, "x")')).toBe(409);
    expect(statusFromText('Response.status(Response.Status.CREATED)')).toBe(201);
    expect(statusFromText('ResponseEntity.status(422).body(x)')).toBe(422);
    expect(throwFromText('throw new WebApplicationException("Duplicate", Response.Status.CONFLICT);')).toEqual({ exception: 'WebApplicationException', message: 'Duplicate', status: 409 });
    expect(throwFromText('.orElseThrow(() -> new NotFoundException("Payment not found"))')).toMatchObject({ exception: 'NotFoundException', message: 'Payment not found' });
    expect([exceptionStatusByName('InvoiceNotFoundException'), exceptionStatusByName('EmailAlreadyExistsException'), exceptionStatusByName('NotFoundException'), exceptionStatusByName('AccessDeniedException')]).toEqual([404, 409, 404, 403]);
  });

  it('takes the resource from the last collection of a nested path', () => {
    expect(resourceFromPath('/api/v1/institutions/{id}/members')).toBe('Member');
    expect(resourceFromPath('/courses/{courseId}/assignments')).toBe('Assignment');
    expect(resourceFromPath('/orders/{id}/cancel')).toBe('Order');
    expect(resourceFromPath('/api/v1/minor-consents/{id}/grant')).toBe('MinorConsent');
    expect(resourceFromPath('/auth/login')).toBeUndefined();
    expect([singular('courses'), singular('addresses'), singular('statuses'), singular('boxes'), singular('categories')]).toEqual(['course', 'address', 'status', 'box', 'category']);
  });
});

describe('ghk reverse on Spring and Quarkus', () => {
  it('Java (brownfield-spring): recovers PlaceOrder and CancelOrder with their states and the 404', async () => {
    const result = await propose('golden/brownfield-spring');
    expect(result.candidates.map(c => c.operation.name).sort()).toEqual(['CancelOrder', 'PlaceOrder']);
    expect(scenarioNames(result, 'CancelOrder')).toEqual(['Cancel the order', 'Cancelling the order fails when the order does not exist']);
    const place = result.candidates.find(c => c.operation.name === 'PlaceOrder')!;
    expect(place.scenarios[0].steps.map(s => s.text)).toEqual(['the user places an order', 'the order is placed', 'the order status is "PENDING"']);
    expect(result.proposals[0].lint.score).toBeGreaterThanOrEqual(80);
  });

  it('Kotlin: follows controller → service, reads roles, validation, @ResponseStatus exceptions, guards and events', async () => {
    const result = await propose('reverse/spring-kotlin-invoices');
    expect(result.candidates.map(c => c.operation.name).sort()).toEqual(['GetInvoice', 'IssueInvoice', 'PayInvoice']);
    expect(scenarioNames(result, 'PayInvoice')).toEqual([
      'Pay the invoice',
      'A user without the ACCOUNTANT role cannot pay the invoice',
      'Paying the invoice fails when the invoice does not exist',
      'Paying the invoice fails when the invoice is not open'
    ]);
    const pay = result.candidates.find(c => c.operation.name === 'PayInvoice')!;
    expect(pay.events).toEqual(['InvoicePaid']);
    expect(pay.confidence).toBe('confirmed'); // the MockMvc test calls POST /api/invoices/{id}/pay
    expect(pay.scenarios[0].steps.map(s => s.text)).toContain('an invoice with status "OPEN"');
    expect(scenarioNames(result, 'IssueInvoice')).toEqual(expect.arrayContaining(['Issuing an invoice is rejected when number is missing', 'Issuing an invoice is rejected when customer email is not a valid email']));
    expect(result.proposals.every(p => p.lint.passed && p.roundTrip.ok)).toBe(true);
  });

  it('Quarkus (JAX-RS): @Path routes, @RolesAllowed, records, orElseThrow and ExceptionMapper statuses', async () => {
    const result = await propose('reverse/quarkus-payments');
    expect(result.candidates.map(c => `${c.operation.method} ${c.operation.path} ${c.operation.name}`).sort()).toEqual([
      'POST /payments InitiatePayment',
      'POST /payments/{id}/settle SettlePayment'
    ]);
    expect(scenarioNames(result, 'SettlePayment')).toEqual(expect.arrayContaining([
      'A user without the teller role cannot settle the payment',
      'Settling the payment fails when the payment does not exist',
      'Settling the payment fails when the payment is not pending'
    ]));
    // PaymentStateException → 409 through the ExceptionMapper: a known status, not an inferred one.
    const notPending = result.candidates.find(c => c.operation.name === 'SettlePayment')!.scenarios.find(s => /not pending/.test(s.name))!;
    expect(notPending.confidence).toBe('strong');
    expect(scenarioNames(result, 'InitiatePayment')).toEqual(expect.arrayContaining(['Initiating a payment is rejected when reference is missing', 'Initiating a payment fails when duplicate payment reference']));
  });
});
