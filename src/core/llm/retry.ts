/* ==========================================================================
   gherkin-ai-cli - HTTP retry for fetch-based providers (Ollama)

   The OpenAI / Anthropic / Gemini SDKs retry internally (configured with the
   same maxRetries / timeout), so this is the only hand-written retry loop and
   it is never nested inside another one.
   ========================================================================== */

import { ProviderError } from '../errors';
import { logger } from '../../utils/logger';

export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function backoffDelayMs(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfterHeader);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return base / 2 + Math.random() * (base / 2); // jitter
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { maxRetries: number; timeoutMs: number; signal?: AbortSignal; label: string }
): Promise<Response> {
  const attempts = options.maxRetries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted) throw new ProviderError(`${options.label} request aborted`, { cause: err });
      const timedOut = timeout.aborted;
      if (attempt === attempts) {
        throw new ProviderError(
          timedOut ? `${options.label} timed out after ${options.timeoutMs}ms (${attempts} attempts)` : `${options.label} connection failed after ${attempts} attempts: ${(err as Error).message}`,
          { retryable: true, cause: err, hint: timedOut ? 'Increase llm.timeoutMs.' : 'Check network access, HTTPS_PROXY/NO_PROXY and network.caFile.' }
        );
      }
      await sleep(backoffDelayMs(attempt), options.label, attempt, 'connection error');
      continue;
    }

    if (res.ok) return res;
    if (RETRYABLE_STATUS.has(res.status) && attempt < attempts) {
      await sleep(backoffDelayMs(attempt, res.headers?.get?.('retry-after')), options.label, attempt, `HTTP ${res.status}`);
      continue;
    }
    if (RETRYABLE_STATUS.has(res.status)) {
      throw new ProviderError(`HTTP ${res.status} after ${attempts} attempts`, { status: res.status, retryable: true });
    }
    const body = await res.text().catch(() => '');
    throw new ProviderError(`HTTP ${res.status}: ${body.slice(0, 500)}`, { status: res.status });
  }
  throw new ProviderError(`${options.label} failed`, { cause: lastError });
}

async function sleep(ms: number, label: string, attempt: number, reason: string): Promise<void> {
  logger.warn(`${label}: ${reason}, retrying in ${(ms / 1000).toFixed(1)}s (attempt ${attempt + 1})`);
  await new Promise(resolve => setTimeout(resolve, ms));
}
