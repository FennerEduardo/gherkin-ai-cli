import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { OpenAIProvider } from '../../src/core/llm/providers/openai';
import type { ResolvedLLMConfig } from '../../src/core/llm/types';

// The OpenAI SDK is a major version newer in 3.2.1 (zod 4): check the wire format against a local gateway.
describe('OpenAIProvider (openai-compatible gateway)', () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: { url?: string; auth?: string; body: any }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        requests.push({ url: req.url, auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        if (body.model === 'denied') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error' } }));
          return;
        }
        res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'gw-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }));
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  const provider = (model: string) => new OpenAIProvider({
    provider: 'openai-compatible', model, apiKey: 'sk-test', credentialSource: 'test', baseUrl, headers: { 'x-team': 'ghk' },
    timeoutMs: 5000, maxRetries: 0, maxOutputTokens: 256, redactPii: false
  } as ResolvedLLMConfig);

  it('sends a JSON chat completion and reads text, model and usage', async () => {
    const r = await provider('m1').complete({ system: 'sys', user: 'hello' } as any);
    expect(r).toEqual({ text: '{"ok":true}', model: 'gw-model', usage: { inputTokens: 11, outputTokens: 3 } });
    const last = requests[requests.length - 1];
    expect(last.url).toBe('/v1/chat/completions');
    expect(last.auth).toBe('Bearer sk-test');
    expect(last.body).toMatchObject({ model: 'm1', max_tokens: 256, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] });
  });

  it('maps API errors to a ProviderError with the status', async () => {
    await expect(provider('denied').complete({ system: 's', user: 'u' } as any)).rejects.toMatchObject({ name: 'ProviderError', status: 401 });
  });
});
