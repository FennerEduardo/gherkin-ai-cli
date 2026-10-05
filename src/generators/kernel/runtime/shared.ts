/* ==========================================================================
   gherkin-ai-cli - Runtime kernel: pieces shared by every language
   (docs/RUNTIME-KERNEL.md). Each language embeds the same SQL and the same
   RabbitMQ topology, so behavior and tests stay identical across stacks.
   ========================================================================== */

import { DomainModel } from '../domain-model';

/** Placeholder replaced at runtime by the (validated) PostgreSQL schema name. */
export const SCHEMA_TOKEN = '__SCHEMA__';

export const RUNTIME_SCHEMA_SQL: string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${SCHEMA_TOKEN}`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_TOKEN}.ghk_aggregates (tenant_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, version INT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, aggregate_type, id))`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_TOKEN}.ghk_outbox (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, traceparent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), claimed_by TEXT, claimed_until TIMESTAMPTZ, published_at TIMESTAMPTZ, attempts INT NOT NULL DEFAULT 0, last_error TEXT, failed_at TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS ghk_outbox_pending ON ${SCHEMA_TOKEN}.ghk_outbox (created_at) WHERE published_at IS NULL AND failed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_TOKEN}.ghk_idempotency (tenant_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, key))`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_TOKEN}.ghk_inbox (consumer TEXT NOT NULL, message_id TEXT NOT NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id))`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_TOKEN}.ghk_sagas (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, completed_steps TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
];

/** Row-level security to enable as defense in depth (connect with a role that is not the table owner). */
export const RLS_NOTE = `-- Defense in depth (optional): enforce tenant isolation in PostgreSQL as well.
-- ALTER TABLE ghk_aggregates ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_isolation ON ghk_aggregates USING (tenant_id = current_setting('app.tenant_id'));
-- and run SET LOCAL app.tenant_id = '<tenant>' at the start of each transaction.`;

export const LEASE_SECONDS = 30;
export const MAX_PUBLISH_ATTEMPTS = 5;

/** RabbitMQ topology for a feature: topic exchange, consumer queue dead-lettering to a fanout DLX/DLQ. */
export function topology(m: DomainModel) {
  return {
    exchange: `${m.kebab}.events`,
    queue: `${m.kebab}.consumer`,
    dlx: `${m.kebab}.dlx`,
    dlq: `${m.kebab}.dlq`
  };
}

/** A W3C traceparent the IT7 tests use as the incoming request context. */
export const TEST_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
export const TEST_PARENT_SPAN_ID = '00f067aa0ba902b7';
export const TEST_TRACEPARENT = `00-${TEST_TRACE_ID}-${TEST_PARENT_SPAN_ID}-01`;
