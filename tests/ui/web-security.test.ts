import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createWebApp } from '../../src/ui/server';

const TOKEN = 'a'.repeat(48);

function request(port: number, urlPath: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: opts.method ?? 'GET',
      headers: { host: `127.0.0.1:${port}`, 'x-ghk-token': TOKEN, ...(payload ? { 'content-type': 'application/json' } : {}), ...opts.headers }
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Web Studio security', () => {
  let server: http.Server;
  let port: number;
  let workspace: string;
  let cwd: string;

  beforeAll(async () => {
    cwd = process.cwd();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-web-'));
    workspace = path.join(base, 'repo');
    fs.mkdirSync(path.join(workspace, 'features'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'features', 'a.feature'), 'Feature: A');
    fs.mkdirSync(path.join(base, 'repo-evil'));
    fs.writeFileSync(path.join(base, 'repo-evil', 'secret.txt'), 'top secret');
    process.chdir(workspace);

    // Find a free port first: the app pins Host/Origin checks to it.
    const probe = http.createServer().listen(0, '127.0.0.1');
    await new Promise(r => probe.once('listening', r));
    port = (probe.address() as AddressInfo).port;
    await new Promise(r => probe.close(r));
    server = createWebApp(port, TOKEN).listen(port, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
  });

  afterAll(async () => {
    await new Promise(r => server.close(r));
    process.chdir(cwd);
  });

  it('requires the session token on API routes', async () => {
    expect((await request(port, '/api/features', { headers: { 'x-ghk-token': '' } })).status).toBe(401);
    expect((await request(port, '/api/features', { headers: { 'x-ghk-token': 'b'.repeat(48) } })).status).toBe(401);
    const ok = await request(port, '/api/features');
    expect(ok.status).toBe(200);
    expect(ok.body.features).toEqual(['a.feature']);
  });

  it('rejects foreign Host headers (DNS rebinding) and cross-origin requests', async () => {
    expect((await request(port, '/api/features', { headers: { host: `localhost.attacker.example:${port}` } })).status).toBe(403);
    expect((await request(port, '/api/features', { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await request(port, '/api/features', { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
  });

  it('blocks path traversal in file and feature endpoints', async () => {
    expect((await request(port, '/api/file?path=' + encodeURIComponent('../repo-evil/secret.txt'))).status).toBe(403);
    expect((await request(port, '/api/file?path=' + encodeURIComponent('/etc/passwd'))).status).toBe(403);
    expect((await request(port, '/api/features/' + encodeURIComponent('../../repo-evil/secret.txt'))).status).toBe(403);
    expect((await request(port, '/api/features/a.feature')).body.content).toBe('Feature: A');
  });

  it('only runs allow-listed commands without shell syntax or --apply', async () => {
    const run = (command: string) => request(port, '/api/execute', { method: 'POST', body: { command } });
    expect((await run('autopilot --requirement x.md')).status).toBe(403);
    expect((await run('lint; rm -rf /')).status).toBe(403);
    expect((await run('verify --apply')).status).toBe(403);
    expect((await run('lint --project=/etc')).status).toBe(403);
  });
});
