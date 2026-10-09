/* ==========================================================================
   gherkin-ai-cli - Application layer over the runtime kernel (all backends)

   One HTTP contract for every stack:
     POST /api/v1/<feature>/{id}/{command}
       body: command payload (JSON object)
       Authorization: Bearer <JWT>  (HS256, JWT_SECRET; tenant from a claim)
       Idempotency-Key: optional, replays return the first result
       traceparent: optional W3C trace context
     202 created | 200 replayed | 409 in progress | 401 no/invalid token or tenant
     422 domain validation error
   The tenant comes only from the validated token, never from a header such
   as X-Tenant-Id, and there is no default tenant.
   ========================================================================== */

import type { GherkinAIConfig } from '../../../core/config';
import type { DomainModel } from '../domain-model';

export const DEFAULT_TENANT_CLAIM = 'tenant_id';

export function tenantClaim(config?: Pick<GherkinAIConfig, 'security'>): string {
  return config?.security?.tenantClaim || DEFAULT_TENANT_CLAIM;
}

/** Route prefix of a feature's commands. */
export const commandRoute = (m: DomainModel) => `/api/v1/${m.kebab}`;

/** Interval of the outbox relay worker. */
export const RELAY_INTERVAL_MS = 1000;
