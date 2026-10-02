import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { LLMClient, createLLMProvider, resetRunBudget, onLLMUsage, resolveLLMSettings } from '../../src/core/llm';
import type { ResolvedLLMConfig } from '../../src/core/llm';
import { defaultConfig, GherkinAIConfig } from '../../src/core/config';
import { configureNetwork, resetNetwork } from '../../src/core/net';
import { PolicyError, ProviderError, ConfigError } from '../../src/core/errors';

interface Recorded { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: any }

function startServer(handler: (req: Recorded, res: http.ServerResponse, n: number) => void) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(rec);
      handler(rec, res, requests.length);
    });
  });
  return new Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const openAIReply = { id: 'x', object: 'chat.completion', created: 0, model: 'gw-model', choices: [{ index: 0, message: { role: 'assistant', content: '{"files":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } };

function settings(overrides: Partial<ResolvedLLMConfig>): ResolvedLLMConfig {
  return { provider: 'openai-compatible', model: 'gw-model', apiKey: 'test-key', credentialSource: 'test', headers: {}, timeoutMs: 5000, maxRetries: 0, maxOutputTokens: 1000, redactPii: false, ...overrides };
}

const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

describe('LLM layer', () => {
  afterEach(() => resetRunBudget());

  it('OpenAI-compatible gateway: forwards headers, uses JSON mode and redacts secrets', async () => {
    const srv = await startServer((_r, res) => json(res, 200, openAIReply));
    try {
      const client = new LLMClient(settings({ baseUrl: `${srv.url}/v1`, headers: { 'x-cost-center': 'cc-42' } }));
      const res = await client.complete({ system: 'sys', user: `token is ${SECRET}` });
      expect(res).toMatchObject({ text: '{"files":[]}', model: 'gw-model', usage: { inputTokens: 11, outputTokens: 7 } });
      const req = srv.requests[0];
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers['x-cost-center']).toBe('cc-42');
      expect(req.body.response_format).toEqual({ type: 'json_object' });
      expect(JSON.stringify(req.body)).not.toContain(SECRET);
      expect(JSON.stringify(req.body)).toContain('[REDACTED:Anthropic Key]');
    } finally {
      await srv.close();
    }
  });

  it('retries 429 honoring Retry-After inside the SDK (single retry layer)', async () => {
    const srv = await startServer((_r, res, n) => (n === 1 ? json(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '0' }) : json(res, 200, openAIReply)));
    try {
      const client = new LLMClient(settings({ baseUrl: `${srv.url}/v1`, maxRetries: 2 }));
      await client.complete({ system: 's', user: 'u' });
      expect(srv.requests).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  it('maps auth failures to ProviderError with a hint and does not retry them', async () => {
    const srv = await startServer((_r, res) => json(res, 401, { error: { message: 'bad key' } }));
    try {
      const client = new LLMClient(settings({ baseUrl: `${srv.url}/v1`, maxRetries: 3 }));
      const err = await client.complete({ system: 's', user: 'u' }).catch(e => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(401);
      expect(err.hint).toMatch(/API key/);
      expect(srv.requests).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it('enforces the request timeout', async () => {
    const srv = await startServer(() => { /* never respond */ });
    try {
      const client = new LLMClient(settings({ baseUrl: `${srv.url}/v1`, timeoutMs: 200 }));
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(ProviderError);
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('Anthropic: sends structured-output schema and maps refusals', async () => {
    const srv = await startServer((req, res) =>
      json(res, 200, {
        id: 'msg', type: 'message', role: 'assistant', model: req.body.model,
        content: [{ type: 'text', text: '{"files":[]}' }],
        stop_reason: req.body.system.includes('refuse') ? 'refusal' : 'end_turn',
        stop_details: req.body.system.includes('refuse') ? { type: 'refusal', category: 'cyber', explanation: 'nope' } : null,
        usage: { input_tokens: 5, output_tokens: 3 }
      })
    );
    try {
      const client = new LLMClient(settings({ provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: srv.url }));
      const schema = { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] };
      const ok = await client.complete({ system: 'sys', user: 'u', jsonSchema: schema });
      expect(ok.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
      expect(srv.requests[0].body.output_config).toEqual({ format: { type: 'json_schema', schema } });
      expect(srv.requests[0].headers['x-api-key']).toBe('test-key');

      const refusal = await client.complete({ system: 'please refuse', user: 'u' }).catch(e => e);
      expect(refusal).toBeInstanceOf(ProviderError);
      expect(refusal.message).toContain('cyber');
    } finally {
      await srv.close();
    }
  });

  it('enforces the per-run token budget and reports usage', async () => {
    const srv = await startServer((_r, res) => json(res, 200, openAIReply));
    const events: unknown[] = [];
    const off = onLLMUsage(e => events.push(e));
    try {
      const client = new LLMClient(settings({ baseUrl: `${srv.url}/v1`, budget: { maxTokensPerRun: 10 } }));
      await client.complete({ system: 's', user: 'u' }); // uses 18 tokens
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(PolicyError);
      expect(srv.requests).toHaveLength(1);
      expect(events).toHaveLength(1);
    } finally {
      off();
      await srv.close();
    }
  });

  it('routes provider traffic through the corporate proxy (CONNECT tunnel)', async () => {
    const backend = await startServer((_r, res) => json(res, 200, openAIReply));
    const connects: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      connects.push(req.url ?? '');
      // Every tunnel goes to the local backend, whatever host was requested.
      const { port } = new URL(backend.url);
      const upstream = net.connect(Number(port), '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    });
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      configureNetwork({ proxy: proxyUrl }, {});
      const client = new LLMClient(settings({ baseUrl: 'http://llm.gateway.internal.test/v1' }));
      const res = await client.complete({ system: 's', user: 'u' });
      expect(res.text).toBe('{"files":[]}');
      expect(connects).toEqual(['llm.gateway.internal.test:80']);
      expect(backend.requests[0].url).toBe('/v1/chat/completions');
    } finally {
      resetNetwork();
      proxy.closeAllConnections();
      await new Promise(r => proxy.close(r));
      await backend.close();
    }
  });

  it('validates provider-specific required settings', async () => {
    await expect(createLLMProvider(settings({ provider: 'openai-compatible', baseUrl: undefined }))).rejects.toBeInstanceOf(ConfigError);
    await expect(createLLMProvider(settings({ provider: 'azure-openai', azure: { endpoint: 'https://x.openai.azure.com' } }))).rejects.toThrow(/deployment/);
    await expect(createLLMProvider(settings({ provider: 'vertex' }))).rejects.toThrow(/project/);
  });
});

describe('LLM policy resolution', () => {
  const base = (llm: GherkinAIConfig['llm']): GherkinAIConfig => ({ ...defaultConfig, llm });

  it('rejects providers, models and endpoints outside the organization allow-lists', () => {
    const env = { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' };
    expect(() => resolveLLMSettings({ config: base({ provider: 'openai', allowedProviders: ['azure-openai'] }), env })).toThrow(PolicyError);
    expect(() => resolveLLMSettings({ config: base({ provider: 'anthropic', model: 'claude-haiku-4-5', allowedModels: ['claude-opus-*'] }), env })).toThrow(/not allowed/);
    expect(resolveLLMSettings({ config: base({ provider: 'anthropic', model: 'claude-opus-5-5', allowedModels: ['claude-opus-*'] }), env }).model).toBe('claude-opus-5-5');
    expect(() => resolveLLMSettings({ config: base({ provider: 'openai', baseUrl: 'https://evil.example', allowedBaseUrls: ['https://gw.corp/*'] }), env })).toThrow(PolicyError);
  });

  it('fails fast with ConfigError when the selected provider has no key', () => {
    expect(() => resolveLLMSettings({ config: base({ provider: 'anthropic' }), env: { OPENAI_API_KEY: 'k' } })).toThrow(ConfigError);
  });

  it('does not require a key for ambient-credential providers', () => {
    const resolved = resolveLLMSettings({ config: base({ provider: 'bedrock', bedrock: { region: 'eu-west-1' } }), env: {} });
    expect(resolved).toMatchObject({ provider: 'bedrock', model: 'anthropic.claude-opus-5-5', credentialSource: 'ambient' });
  });
});
