import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { createGraphServer } from '../../src/core/graph/graph-server';

const TOKEN = 'a'.repeat(48);
let dir: string;
let server: http.Server;
let port: number;

const get = (pathname: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-graph-serve-'));
  fs.mkdirSync(path.join(dir, 'features'));
  fs.writeFileSync(path.join(dir, 'features', 'orders.feature'), 'Feature: Orders\n  Scenario: Place\n    When the customer places an order\n    Then an "OrderPlaced" event is published\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'orders.ts'), '// ghk:trace feature=features/orders.feature\nexport class OrderService {}\n');
  server = createGraphServer(dir, { token: TOKEN });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ghk graph --serve (4.9)', () => {
  it('serves a self-contained page with a nonce CSP', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    const nonce = /script-src 'nonce-([^']+)'/.exec(String(res.headers['content-security-policy']))?.[1];
    expect(nonce).toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonce}">`);
    expect(res.body).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    // The inline script must at least parse (it is written inside a TypeScript template literal).
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(res.body)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it('requires the session token for the data and rebuilds the graph from the project', async () => {
    expect((await get('/api/graph')).status).toBe(401);
    expect((await get('/api/graph', { 'X-Ghk-Token': 'b'.repeat(48) })).status).toBe(401);
    const graph = JSON.parse((await get('/api/graph', { 'X-Ghk-Token': TOKEN })).body);
    expect(graph.nodes.some((n: { kind: string; path?: string }) => n.kind === 'feature' && n.path === 'features/orders.feature')).toBe(true);
    expect(graph.nodes.some((n: { path?: string }) => n.path === 'src/orders.ts')).toBe(true);

    const trace = JSON.parse((await get('/api/trace?q=features%2Forders.feature', { 'X-Ghk-Token': TOKEN })).body);
    expect(trace.roots).toHaveLength(1);
    expect(trace.nodes.some((n: { path?: string }) => n.path === 'src/orders.ts')).toBe(true);
  });

  it('rejects other hosts (DNS rebinding) and other methods', async () => {
    expect((await get('/api/graph', { Host: `evil.example:${port}`, 'X-Ghk-Token': TOKEN })).status).toBe(403);
    expect((await get('/', { Host: `localhost.evil.example:${port}` })).status).toBe(403);
    expect((await get('/api/graph', { 'X-Ghk-Token': TOKEN }, 'POST')).status).toBe(405);
  });
});
