/* The one way a tool reaches the service: its approved handler, on the configured base URL, and nowhere else.
 * - The URL is built from the handler's path template; arguments only fill its placeholders (encoded), so
 *   an argument can never change the host, the path outside the service, or add a scheme (no SSRF).
 * - Redirects are refused; the response is read up to a size limit.
 * - The caller's token is never forwarded: the service receives its own credential (a short-lived token
 *   minted for the caller's subject and tenant, or a service token), so the agent never sees it.
 * - Idempotency-Key is scoped to the caller, and traceparent links the call to the agent's trace. */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { RuntimeConfig } from './config';
import type { Identity } from './jwt';
import type { Capability } from './types';

export interface UpstreamResult {
  status: number;
  body: unknown;
}

export class UpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface TraceContext {
  traceId: string;
  traceparent: string;
}

/** A child of the caller's trace when it sent one, else a new trace. */
export function traceContext(incoming: string | undefined): TraceContext {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(incoming ?? '').trim());
  const traceId = m && !/^0+$/.test(m[1]) ? m[1] : randomBytes(16).toString('hex');
  return { traceId, traceparent: '00-' + traceId + '-' + randomBytes(8).toString('hex') + '-' + (m ? m[3] : '01') };
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

function mintToken(cfg: RuntimeConfig, identity: Identity, tenantClaim: string, cap: Capability): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: 'ghk-mcp-runtime',
    sub: identity.subject,
    [tenantClaim]: identity.tenant,
    scope: cap.authorization.scopes.join(' '),
    iat: now,
    exp: now + 60,
    act: { sub: identity.clientId ?? 'agent' }
  };
  if (cfg.upstreamAudience) claims.aud = cfg.upstreamAudience;
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', cfg.upstreamJwtSecret!).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}

/** The caller's key, scoped to the caller: two users never share a replay. */
export function scopedIdempotencyKey(identity: Identity, key: string): string {
  return createHash('sha256').update(identity.tenant + '\n' + identity.subject).digest('hex').slice(0, 16) + '.' + key;
}

export function buildRequest(cfg: RuntimeConfig, cap: Capability, args: Record<string, unknown>): { url: URL; headers: Record<string, string>; body?: string } {
  const used = new Set<string>();
  const headers: Record<string, string> = {};
  const query = new URLSearchParams();
  let path = cap.handler.path;
  for (const p of cap.handler.parameters) {
    const raw = p.value ?? (p.argument !== undefined ? args[p.argument] : undefined);
    if (p.argument) used.add(p.argument);
    if (raw === undefined || raw === null || raw === '') {
      if (p.in === 'path') throw new UpstreamError('Missing argument ' + (p.argument ?? p.name) + '.');
      continue;
    }
    const value = String(raw);
    if (p.in === 'path') {
      if (value === '.' || value === '..') throw new UpstreamError('Invalid value for ' + (p.argument ?? p.name) + '.');
      path = path.split('{' + p.name + '}').join(encodeURIComponent(value));
    } else if (p.in === 'query') query.append(p.name, value);
    else if (p.in === 'header' && /^[\x20-\x7e]{1,256}$/.test(value)) headers[p.name] = value;
  }
  if (/\{[^}]+\}/.test(path)) throw new UpstreamError('The handler path has an unfilled placeholder.');
  const base = cfg.upstreamUrl;
  const basePath = base.pathname.replace(/\/+$/, '');
  const url = new URL(base.origin + basePath + path);
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath + '/')) throw new UpstreamError('The request would leave the service.');
  query.forEach((v, k) => url.searchParams.append(k, v));
  let body: string | undefined;
  if (cap.handler.body && cap.handler.method !== 'GET') {
    const payload = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k) && k !== 'idempotency_key'));
    body = JSON.stringify(payload);
  }
  return { url, headers, body };
}

async function readLimited(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError('The service response is larger than ' + limit + ' bytes.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function callUpstream(
  cfg: RuntimeConfig,
  cap: Capability,
  args: Record<string, unknown>,
  identity: Identity,
  ctx: { trace: TraceContext; tenantClaim: string; scenario?: string }
): Promise<UpstreamResult> {
  const req = buildRequest(cfg, cap, args);
  const headers: Record<string, string> = { accept: 'application/json', traceparent: ctx.trace.traceparent, ...req.headers };
  if (ctx.scenario) headers.baggage = 'ghk.scenario=' + encodeURIComponent(ctx.scenario) + ',ghk.tool=' + encodeURIComponent(cap.name);
  for (const p of cap.handler.parameters) {
    if (p.in === 'header' && p.argument === 'idempotency_key' && typeof args.idempotency_key === 'string') headers[p.name] = scopedIdempotencyKey(identity, args.idempotency_key);
  }
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  if (cfg.upstreamAuth === 'mint-hs256') headers.authorization = 'Bearer ' + mintToken(cfg, identity, ctx.tenantClaim, cap);
  else if (cfg.upstreamAuth === 'bearer') headers.authorization = 'Bearer ' + cfg.upstreamToken;

  let res: Response;
  try {
    res = await fetch(req.url, { method: cap.handler.method, headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(cap.execution.timeoutMs) });
  } catch (err) {
    throw new UpstreamError((err as Error).name === 'TimeoutError' ? 'The service did not answer within ' + cap.execution.timeoutMs + ' ms.' : 'The service is unreachable.');
  }
  if (res.status >= 300 && res.status < 400) throw new UpstreamError('The service answered with a redirect, which is refused.', res.status);
  const text = await readLimited(res, cfg.maxResponseBytes);
  let body: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('json') && text) {
    try { body = JSON.parse(text); } catch { /* keep the text */ }
  }
  return { status: res.status, body };
}
