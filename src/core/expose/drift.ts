/* ==========================================================================
   gherkin-ai-cli - `ghk expose drift` (PLAN-3.3.0-reverse-plus EX-11)

   The tools agents actually see against the approved manifest: tools that
   are served but not approved (extra), approved but not served (missing),
   or served with another description, input schema or effect. The source
   is a deployed MCP endpoint (tools/list over Streamable HTTP, with a
   token from an environment variable) or the generated runtime on disk.
   It extends `converge --live` to MCP. Exit 7 on drift.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { isWrite, ordinal } from './manifest';
import type { ProviderManifestView } from './provider-types';

export interface ServedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface DriftItem {
  tool: string;
  kind: 'extra' | 'missing' | 'description' | 'input' | 'effect';
  detail: string;
}

/** The runtime's own read-only tools: not capabilities, never drift. */
const CONTEXT_TOOL = /^bdd_/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function compareTools(view: ProviderManifestView, served: ServedTool[]): DriftItem[] {
  const items: DriftItem[] = [];
  const approved = view.capabilities.filter(c => c.status === 'approved');
  const tools = served.filter(t => !CONTEXT_TOOL.test(t.name));
  for (const t of tools) {
    const cap = approved.find(c => c.name === t.name);
    if (!cap) {
      items.push({ tool: t.name, kind: 'extra', detail: 'served but not approved in .ghk/capabilities.yaml' });
      continue;
    }
    if (t.description !== undefined && t.description !== cap.description) items.push({ tool: t.name, kind: 'description', detail: 'the served description differs from the approved one' });
    if (t.inputSchema !== undefined && cap.input && !same(t.inputSchema, cap.input)) items.push({ tool: t.name, kind: 'input', detail: 'the served input schema differs from the approved one' });
    if (t.annotations?.readOnlyHint !== undefined && t.annotations.readOnlyHint === isWrite(cap.effect)) {
      items.push({ tool: t.name, kind: 'effect', detail: `served as ${t.annotations.readOnlyHint ? 'read-only' : 'a write'}, approved as ${cap.effect}` });
    }
  }
  for (const c of approved) if (!tools.some(t => t.name === c.name)) items.push({ tool: c.name, kind: 'missing', detail: 'approved but not served (or not visible to this caller: use a token with every scope)' });
  return items.sort((a, b) => ordinal(a.tool, b.tool) || ordinal(a.kind, b.kind));
}

/** The tools of a generated runtime directory (expose/mcp-runtime/config/capabilities.json). */
export function generatedRuntimeTools(dir: string): ServedTool[] {
  const file = path.join(dir, 'config', 'capabilities.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found: run \`ghk expose generate\` first, or pass --url.`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { capabilities: { name: string; description: string; input: Record<string, unknown>; effect: string }[] };
  return data.capabilities.map(c => ({ name: c.name, description: c.description, inputSchema: c.input, annotations: { readOnlyHint: !isWrite(c.effect) } }));
}

/** A JSON-RPC answer from a JSON or an event-stream (SSE) response. */
function answer(text: string, contentType: string, id: number): any {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg?.id === id) return msg;
      } catch { /* keep reading */ }
    }
    return undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

/** tools/list of a deployed MCP endpoint (Streamable HTTP), following pagination. */
export async function servedTools(url: string, token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<ServedTool[]> {
  let session: string | undefined;
  let id = 0;
  const call = async (method: string, params?: unknown, notification = false) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session ? { 'mcp-session-id': session } : {})
      },
      body: JSON.stringify(notification ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) } : { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) })
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (res.status === 401 || res.status === 403) throw new Error(`${url} answered ${res.status}: the token (--token-env) is missing or not accepted.`);
    const text = await res.text();
    if (notification) return undefined;
    if (!res.ok) throw new Error(`${url} answered ${res.status} to ${method}.`);
    const msg = answer(text, res.headers.get('content-type') ?? '', id);
    if (!msg || msg.error) throw new Error(`${method}: ${msg?.error?.message ?? 'no answer'}`);
    return msg.result;
  };
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ghk-expose-drift', version: '1.0.0' } });
  await call('notifications/initialized', undefined, true);
  const tools: ServedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await call('tools/list', cursor ? { cursor } : undefined);
    tools.push(...(result?.tools ?? []));
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}
