/* ==========================================================================
   `ghk reverse` on ASP.NET Core, FastAPI and Go (PLAN-3.3.0 R-08..R-10,
   beta since 3.3.0, validated on RealWorld apps by scripts/reverse-oss.js). Hand-written services through tree-sitter:
   - aspnet-orders: controller → service through an interface, [Authorize]
     roles, a validated record, a state guard, an event, a Minimal API route
     and an HttpClient test;
   - fastapi-orders: APIRouter prefix, Depends auth/roles, a Pydantic model,
     HTTPException statuses, a service module and a TestClient test;
   - go-orders: chi routes and groups, auth middleware, validate tags,
     sentinel errors linked to the service condition, net/http 1.22 routes.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { runPropose, runScan } from '../../src/core/reverse';
import { csharpStatus } from '../../src/core/reverse/analyzers/csharp/aspnet';
import { pythonStatus } from '../../src/core/reverse/analyzers/python/fastapi';
import { goStatus } from '../../src/core/reverse/analyzers/go/go-http';
import { eventsInText, pathMatchesTemplate, statesInText } from '../../src/core/reverse/analyzers/shared/body-text';
import { expandedNames } from './support-outline';
import { exceptionStatusByName } from '../../src/core/reverse/analyzers/jvm/spring';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'reverse');
const propose = async (rel: string) => runPropose(path.join(FIXTURES, rel), await runScan(path.join(FIXTURES, rel), { write: false }), { write: false });
const op = (r: Awaited<ReturnType<typeof propose>>, name: string) => r.candidates.find(c => c.operation.name === name)!;
const names = (r: Awaited<ReturnType<typeof propose>>, name: string) => expandedNames(op(r, name)?.scenarios);
const steps = (r: Awaited<ReturnType<typeof propose>>, name: string) => op(r, name).scenarios[0].steps.map(s => `${s.keyword} ${s.text}`);

describe('status and text helpers', () => {
  it('reads statuses as each framework names them', () => {
    expect([csharpStatus('return NotFound();'), csharpStatus('Results.Conflict("x")'), csharpStatus('StatusCode(StatusCodes.Status422UnprocessableEntity)'), csharpStatus('CreatedAtAction(nameof(Get), x)')]).toEqual([404, 409, 422, 201]);
    expect([pythonStatus('HTTPException(status_code=404, detail="x")'), pythonStatus('HTTPException(status.HTTP_409_CONFLICT, "x")'), pythonStatus('HTTPException(422)')]).toEqual([404, 409, 422]);
    expect([goStatus('http.Error(w, "x", http.StatusNotFound)'), goStatus('c.JSON(409, gin.H{})'), goStatus('w.WriteHeader(http.StatusCreated)')]).toEqual([404, 409, 201]);
    expect([exceptionStatusByName('InvalidOperationException'), exceptionStatusByName('IllegalStateException'), exceptionStatusByName('KeyNotFoundException')]).toEqual([409, 409, 404]);
  });

  it('finds states and events in any language and matches concrete test URLs to templates', () => {
    const scope = (text: string) => ({ text, startLine: 1, file: 'x', extractor: 't', endpointId: 'ev-1' });
    const values = (text: string) => statesInText(scope(text)).map(e => (e.metadata as any).value);
    expect(values('order.Status = OrderStatus.Cancelled;')).toEqual(['Cancelled']);
    expect(values('o := &Order{ID: id, Status: "PENDING"}')).toEqual(['PENDING']);
    expect(values('Order(customer_email=e, status=OrderStatus.PENDING)')).toEqual(['PENDING']);
    const events = (text: string) => eventsInText(scope(text)).map(e => (e.metadata as any).event);
    expect(events('await _publisher.PublishAsync(new OrderPlacedEvent(order.Id));')).toEqual(['OrderPlaced']);
    expect(events('bus.publish("OrderPlaced", {})')).toEqual(['OrderPlaced']);
    expect(events('s.bus.Publish("order.placed", o)')).toEqual(['OrderPlaced']);
    expect(events('record(new DomainEvent("CourseCreated", id))')).toEqual(['CourseCreated']);
    expect(pathMatchesTemplate('/api/orders/{id}/cancel', '/api/orders/o-1/cancel')).toBe(true);
    expect(pathMatchesTemplate('/api/orders/{id}/cancel', '/api/orders/o-1')).toBe(false);
  });
});

describe('ghk reverse on ASP.NET Core', () => {
  it('controllers, interfaces, roles, DataAnnotations, state guard, event, Minimal API and test confirmation', async () => {
    const r = await propose('aspnet-orders');
    expect(r.candidates.map(c => `${c.operation.method} ${c.operation.path} ${c.operation.name}`).sort()).toEqual([
      'GET /api/orders/{id} GetOrder', 'POST /api/orders CreateOrder', 'POST /api/orders/{id}/cancel CancelOrder', 'POST /api/shipments/{id}/dispatch DispatchShipment'
    ].map(s => s.replace('CreateOrder', 'PlaceOrder')).sort());
    expect(steps(r, 'PlaceOrder')).toEqual(expect.arrayContaining(['Then the order is placed', 'And the order status is "Pending"', 'And the "OrderPlaced" event is published']));
    expect(names(r, 'CancelOrder')).toEqual(expect.arrayContaining([
      'A user without the Manager role cannot cancel the order',
      'Cancelling the order fails when the order does not exist',
      'Cancelling the order fails when the order is not pending'
    ]));
    expect(op(r, 'CancelOrder').confidence).toBe('confirmed'); // the HttpClient test posts /api/orders/o-1/cancel
    expect(names(r, 'PlaceOrder')).toEqual(expect.arrayContaining(['Placing an order is rejected when customer email is not a valid email']));
    expect(names(r, 'DispatchShipment')).toEqual(expect.arrayContaining(['An unauthenticated user cannot dispatch the shipment']));
    expect(r.proposals.every(p => p.lint.passed && p.roundTrip.ok)).toBe(true);
  });
});

describe('ghk reverse on FastAPI', () => {
  it('router prefix, Depends auth and roles, Pydantic rules, HTTPException and the service module', async () => {
    const r = await propose('fastapi-orders');
    expect(r.candidates.map(c => `${c.operation.method} ${c.operation.path} ${c.operation.name}`).sort()).toEqual([
      'GET /orders/{order_id} GetOrder', 'POST /orders PlaceOrder', 'POST /orders/{order_id}/cancel CancelOrder'
    ]);
    expect(steps(r, 'PlaceOrder')).toEqual(expect.arrayContaining(['Then the order is placed', 'And the order status is "PENDING"', 'And the "OrderPlaced" event is published']));
    expect(op(r, 'PlaceOrder').confidence).toBe('confirmed'); // TestClient posts /orders
    expect(names(r, 'CancelOrder')).toEqual(expect.arrayContaining([
      'A user without the manager role cannot cancel the order',
      'Cancelling the order fails when the order does not exist',
      'Cancelling the order fails when the order is not pending'
    ]));
    expect(names(r, 'PlaceOrder')).toEqual(expect.arrayContaining(['Placing an order is rejected when customer email is not a valid email', 'An unauthenticated user cannot place an order']));
    // /health is a platform route, never an operation.
    expect(r.candidates.some(c => c.operation.path === '/health')).toBe(false);
  });
});

describe('ghk reverse on Go', () => {
  it('chi groups and middleware, validate tags, sentinel errors linked to the service condition, net/http 1.22', async () => {
    const r = await propose('go-orders');
    expect(r.candidates.map(c => `${c.operation.method} ${c.operation.path} ${c.operation.name}`).sort()).toEqual([
      'POST /orders PlaceOrder', 'POST /orders/{id}/cancel CancelOrder', 'POST /shipments/{id}/dispatch DispatchShipment'
    ]);
    expect(names(r, 'CancelOrder')).toEqual(expect.arrayContaining([
      'An unauthenticated user cannot cancel the order',
      'Cancelling the order fails when the order does not exist',
      'Cancelling the order fails when the order is not pending'
    ]));
    expect(steps(r, 'CancelOrder')).toEqual(expect.arrayContaining(['And an order with status "PENDING"', 'And the order status is "CANCELLED"']));
    expect(steps(r, 'PlaceOrder')).toEqual(expect.arrayContaining(['And the "OrderPlaced" event is published']));
    expect(names(r, 'PlaceOrder')).toEqual(expect.arrayContaining(['Placing an order is rejected when customer email is not a valid email']));
    expect(r.proposals.every(p => p.lint.passed && p.roundTrip.ok)).toBe(true);
  });
});

describe('Go: gin groups handed to registration functions (3.3.0, found on the RealWorld gin app)', () => {
  it('routes take the prefix of the group each caller passes, and a route registered twice is one endpoint', async () => {
    const scan = await runScan(path.join(FIXTURES, 'go-gin-groups'), { write: false });
    const endpoints = scan.evidence.filter(e => e.kind === 'http-endpoint').map(e => `${(e.metadata as any).method} ${(e.metadata as any).path}`).sort();
    expect(endpoints).toEqual([
      'GET /api/articles/{slug}',
      'GET /api/ping',
      'POST /api/users',
      'POST /api/users/login',
      'PUT /api/articles/{slug}'
    ]);
  });
});
