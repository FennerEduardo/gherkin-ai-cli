/* ==========================================================================
   `ghk reverse`: GraphQL and gRPC (PLAN-3.3.0-reverse-plus RV-14). The
   schema states the operations; resolvers in the code say what they do.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { runScan } from '../../src/core/reverse';
import { buildCandidates, rpcOperationName } from '../../src/core/reverse/candidates';
import { graphqlOperations, protoOperations } from '../../src/core/reverse/analyzers/contracts/graphql-grpc';
import { renderProposals } from '../../src/core/reverse/renderer';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';

const DIR = path.join(__dirname, '..', 'fixtures', 'reverse', 'graphql-grpc');

describe('reverse: GraphQL and gRPC', () => {
  it('reads Mutation and Query fields, and proto rpcs', () => {
    const gql = graphqlOperations('type Query { orders: [Order!]! }\nextend type Mutation {\n  # a comment\n  placeOrder(customerEmail: String!, note: String): Order!\n}');
    expect(gql.map(o => `${o.kind}:${o.operation}->${o.returns}`)).toEqual(['query:orders->Order', 'mutation:placeOrder->Order']);
    expect(gql[1].args).toEqual([{ name: 'customerEmail', type: 'String', required: true }, { name: 'note', type: 'String', required: false }]);
    const rpc = protoOperations('service PaymentService {\n  rpc AuthorizePayment (AuthorizePaymentRequest) returns (Payment);\n  rpc GetPayment (GetPaymentRequest) returns (stream Payment);\n}\n');
    expect(rpc.map(o => `${o.kind}:${o.service}.${o.operation}`)).toEqual(['mutation:PaymentService.AuthorizePayment', 'query:PaymentService.GetPayment']);
    expect(rpcOperationName('placeOrder', 'mutation', 'Order').name).toBe('PlaceOrder');
    expect(rpcOperationName('orders', 'query', 'Order').name).toBe('ListOrders');
    expect(rpcOperationName('order', 'query', 'Order').name).toBe('GetOrder');
  });

  it('merges the schema and the resolver of each operation, with the resolver body as outcome', async () => {
    clearTsProjects();
    const scan = await runScan(DIR, { write: false });
    const { candidates } = buildCandidates(scan.evidence);
    const by = (name: string) => candidates.find(c => c.operation.name === name)!;
    expect(candidates.map(c => `${c.operation.method} ${c.operation.name}`).sort()).toEqual([
      'GRAPHQL CancelOrder', 'GRAPHQL GetOrder', 'GRAPHQL ListOrders', 'GRAPHQL PlaceOrder', 'GRPC AuthorizePayment', 'GRPC GetPayment'
    ]);
    // Declared in the schema and implemented in the code: confirmed. Declared only: strong, from the schema's return type.
    expect(by('PlaceOrder').scenarios[0]).toMatchObject({ confidence: 'confirmed' });
    expect(by('PlaceOrder').scenarios[0].steps.map(s => `${s.keyword} ${s.text}`)).toEqual(['When the client sends the "placeOrder" mutation', 'Then the order status is "PENDING"', 'And the "OrderPlaced" event is published']);
    expect(by('CancelOrder').scenarios.map(s => s.name)).toContain('Cancelling an order fails when the order is not pending');
    expect(by('ListOrders').scenarios[0].steps.map(s => s.text)).toContain('the orders are returned');
    expect(by('GetPayment').scenarios[0]).toMatchObject({ confidence: 'strong' });
    expect(by('GetPayment').scenarios[0].steps.map(s => s.text)).toEqual(['the client calls PaymentService.GetPayment', 'the payment is returned']);
    expect(by('AuthorizePayment').aggregate).toBe('Payment');
    expect(by('AuthorizePayment').scenarios[0].steps.map(s => s.text)).toEqual(['the client calls PaymentService.AuthorizePayment', 'the payment status is "AUTHORIZED"']);
    for (const p of renderProposals(candidates, scan.evidence)) {
      expect(p.roundTrip.ok, p.file).toBe(true);
      expect(p.lint.score, p.file).toBeGreaterThanOrEqual(80);
    }
  }, 60000);
});
