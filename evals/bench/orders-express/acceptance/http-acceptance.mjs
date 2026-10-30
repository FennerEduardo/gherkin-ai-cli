#!/usr/bin/env node
// Hidden acceptance test of the "orders" bench tasks, identical for every stack: it starts the service with the
// command given as arguments (PORT=18080), waits for GET /health, and checks the HTTP contract of REQUIREMENTS.md.
// Exit 0 only when every check passes. Usage: node acceptance/http-acceptance.mjs <start command...>
import { spawn } from 'node:child_process';

const port = 18080;
const base = `http://127.0.0.1:${port}`;
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: http-acceptance.mjs <start command...>'); process.exit(2); }
const server = spawn(cmd, args, { env: { ...process.env, PORT: String(port), SERVER_PORT: String(port) }, stdio: 'inherit', shell: process.platform === 'win32' });

const auth = { authorization: 'Bearer bench-token', 'content-type': 'application/json' };
const call = async (method, path, body, headers = auth) => {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json; try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, body: json };
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); };

try {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).status === 200; } catch { /* starting */ }
    if (!up) await new Promise(r => setTimeout(r, 1000));
  }
  check('GET /health answers 200 within 3 minutes', up, 'the service did not start');
  if (up) {
    const placed = await call('POST', '/orders', { items: [{ sku: 'BOOK-1', quantity: 2 }] });
    check('POST /orders places a PENDING order (201)', placed.status === 201 && placed.body?.status === 'PENDING' && typeof placed.body?.id === 'string', JSON.stringify(placed));
    const id = placed.body?.id ?? 'missing';
    const anonymous = await call('POST', '/orders', { items: [{ sku: 'BOOK-1', quantity: 1 }] }, { 'content-type': 'application/json' });
    check('POST /orders without a bearer token is 401', anonymous.status === 401, JSON.stringify(anonymous));
    const empty = await call('POST', '/orders', { items: [] });
    check('POST /orders without items is 422', empty.status === 422, JSON.stringify(empty));
    const zero = await call('POST', '/orders', { items: [{ sku: 'BOOK-1', quantity: 0 }] });
    check('POST /orders with quantity 0 is 422', zero.status === 422, JSON.stringify(zero));
    const read = await call('GET', `/orders/${id}`);
    check('GET /orders/{id} returns the order', read.status === 200 && read.body?.id === id, JSON.stringify(read));
    const cancelled = await call('POST', `/orders/${id}/cancel`, {});
    check('POST /orders/{id}/cancel cancels a PENDING order (200)', cancelled.status === 200 && cancelled.body?.status === 'CANCELLED', JSON.stringify(cancelled));
    const again = await call('POST', `/orders/${id}/cancel`, {});
    check('cancelling a cancelled order is 409', again.status === 409, JSON.stringify(again));
    const unknown = await call('POST', '/orders/does-not-exist/cancel', {});
    check('cancelling an unknown order is 404', unknown.status === 404, JSON.stringify(unknown));
  }
} finally {
  server.kill('SIGTERM');
}
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} acceptance checks passed`);
process.exit(failed ? 1 : 0);
