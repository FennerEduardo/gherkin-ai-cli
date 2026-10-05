import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildRepositoryGraph, graphToDot, graphToMermaid, isTestPath, scopeForFeature, symbolVariants, traceGraph } from '../../src/core/graph/repository-graph';

const FEATURE = `Feature: Payment Capture
  As a merchant
  I want to capture payments

  Scenario: Capture payment successfully
    Given a valid payment capture request with required payload
    When processing payment capture request
    Then the system responds with HTTP status 200 OK
    And emits a "PaymentCaptureProcessed" domain event
`;

let dir: string;

function write(rel: string, content: string) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-graph-'));
  write('features/payment-capture.feature', FEATURE);
  write('src/payments/payment.service.ts', 'export class PaymentService { emit() { return { type: "PaymentCaptureProcessed" }; } }\n');
  write('src/payments/payment.service.test.ts', 'import "./payment.service"; expect("PaymentCaptureProcessed").toBeDefined();\n');
  write('src/unrelated/other.ts', 'export const nothing = 1;\n');
  write('node_modules/lib/index.js', 'PaymentCaptureProcessed\n');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('semantic repository graph', () => {
  it('links the feature, its event and the files and tests that reference it', () => {
    const graph = buildRepositoryGraph(dir);
    expect(graph.stats.feature).toBe(1);
    const event = graph.nodes.find(n => n.kind === 'event' && n.label === 'PaymentCaptureProcessed');
    expect(event).toBeDefined();
    const implementers = graph.edges.filter(e => e.to === event!.id && e.kind === 'implements').map(e => e.from);
    const testers = graph.edges.filter(e => e.to === event!.id && e.kind === 'tests').map(e => e.from);
    expect(implementers).toEqual(['file:src/payments/payment.service.ts']);
    expect(testers).toEqual(['test:src/payments/payment.service.test.ts']);
    expect(graph.nodes.some(n => n.path?.startsWith('node_modules'))).toBe(false);
    expect(graph.nodes.some(n => n.path === 'src/unrelated/other.ts')).toBe(false);
  });

  it('traces a symbol to its feature, code and tests', () => {
    const trace = traceGraph(buildRepositoryGraph(dir), 'PaymentCaptureProcessed');
    const kinds = new Set(trace.nodes.map(n => n.kind));
    expect(trace.roots).toHaveLength(1);
    expect(kinds).toEqual(new Set(['event', 'feature', 'file', 'test', 'command', 'scenario', 'endpoint'].filter(k => trace.nodes.some(n => n.kind === k))));
    expect(kinds.has('feature') && kinds.has('file') && kinds.has('test')).toBe(true);
  });

  it('derives the change scope of a feature', () => {
    const scope = scopeForFeature(buildRepositoryGraph(dir), 'features/payment-capture.feature');
    expect(scope.files).toContain('src/payments/payment.service.ts');
    expect(scope.globs).toContain('src/payments/**');
    expect(scope.globs).not.toContain('src/unrelated/**');
  });

  it('renders Mermaid and Graphviz', () => {
    const graph = buildRepositoryGraph(dir);
    expect(graphToMermaid(graph)).toMatch(/^flowchart LR/);
    expect(graphToMermaid(graph)).toContain('-->|implements|');
    expect(graphToDot(graph)).toMatch(/^digraph ghk \{/);
  });

  it('recognizes test paths across ecosystems and naming variants', () => {
    for (const p of ['src/a.test.ts', 'tests/test_orders.py', 'pkg/orders_test.go', 'spec/orders_spec.rb', 'src/OrdersTests.cs', 'test/orders_test.exs']) expect(isTestPath(p), p).toBe(true);
    expect(isTestPath('src/orders.ts')).toBe(false);
    expect(symbolVariants('place_order')).toEqual(expect.arrayContaining(['PlaceOrder', 'placeOrder', 'place_order', 'place-order']));
  });
});
