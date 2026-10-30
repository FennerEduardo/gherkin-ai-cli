/* ==========================================================================
   gherkin-ai-cli - `ghk audit export` (SIEM-friendly audit trail export)
   ========================================================================== */

import { emitData } from '../utils/output';
import fs from 'fs';
import path from 'path';
import { UsageError } from '../core/errors';
import { AuditLogEntry, getTelemetry } from '../core/telemetry';
import { logger } from '../utils/logger';

export interface AuditExportOptions {
  format?: string;
  since?: string;
  output?: string;
}

const CSV_COLUMNS: (keyof AuditLogEntry)[] = ['timestamp', 'executionId', 'version', 'user', 'host', 'source', 'action', 'resource', 'status', 'details'];

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  // Quote everything that could break a row; neutralize spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Parses an ISO date or a relative window like "24h", "7d", "30m". */
export function parseSince(value: string, now = Date.now()): Date {
  const relative = /^(\d+)([mhd])$/.exec(value.trim());
  if (relative) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'm' | 'h' | 'd'];
    return new Date(now - Number(relative[1]) * ms);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new UsageError(`Invalid --since value "${value}".`, { hint: 'Use an ISO date (2026-10-01) or a window like 24h, 7d.' });
  return date;
}

export type AuditExportFormat = 'jsonl' | 'csv' | 'ocsf';
const FORMATS: AuditExportFormat[] = ['jsonl', 'csv', 'ocsf'];

/** OCSF 1.3 schema version the `ocsf` export follows (https://schema.ocsf.io). */
export const OCSF_VERSION = '1.3.0';
const API_ACTIVITY = 6003; // Application Activity (6) > API Activity

/** OCSF activity_id of an audit action: 1 Create, 2 Read, 3 Update, 4 Delete, 99 Other. */
function ocsfActivity(action: string): { id: number; name: string } {
  if (/clear|delete|remove|purge/i.test(action)) return { id: 4, name: 'Delete' };
  if (/write|create|generate|apply/i.test(action)) return { id: 1, name: 'Create' };
  if (/update|edit|merge/i.test(action)) return { id: 3, name: 'Update' };
  if (/read|get|list|search|show/i.test(action)) return { id: 2, name: 'Read' };
  return { id: 99, name: 'Other' };
}

/**
 * One audit record as an OCSF API Activity event, for SIEMs that ingest OCSF natively (Amazon Security Lake,
 * Splunk, Sentinel, Chronicle). A policy denial is a failure with status_detail "BLOCKED".
 */
export function toOcsfEvent(r: AuditLogEntry): Record<string, unknown> {
  const activity = ocsfActivity(r.action);
  const ok = r.status === 'SUCCESS';
  return {
    class_uid: API_ACTIVITY,
    class_name: 'API Activity',
    category_uid: 6,
    category_name: 'Application Activity',
    activity_id: activity.id,
    activity_name: activity.name,
    type_uid: API_ACTIVITY * 100 + activity.id,
    time: Date.parse(r.timestamp),
    severity_id: r.status === 'BLOCKED' ? 3 : 1,
    severity: r.status === 'BLOCKED' ? 'Medium' : 'Informational',
    status_id: ok ? 1 : 2,
    status: ok ? 'Success' : 'Failure',
    ...(ok ? {} : { status_detail: r.status }),
    ...(r.details ? { message: r.details } : {}),
    metadata: {
      version: OCSF_VERSION,
      product: { name: 'gherkin-ai', vendor_name: 'fenner', version: r.version },
      correlation_uid: r.executionId,
      log_name: 'audit'
    },
    actor: { user: { name: r.user }, app_name: `gherkin-ai ${r.source}` },
    api: { operation: r.action, service: { name: `gherkin-ai ${r.source}` } },
    ...(r.resource ? { resources: [{ name: r.resource }] } : {}),
    src_endpoint: { hostname: r.host },
    ...(r.role ? { unmapped: { role: r.role } } : {})
  };
}

export function formatAuditRecords(records: AuditLogEntry[], format: AuditExportFormat): string {
  if (format === 'jsonl') return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  if (format === 'ocsf') return records.map(r => JSON.stringify(toOcsfEvent(r))).join('\n') + (records.length ? '\n' : '');
  const rows = records.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

export async function handleAuditExportCommand(options: AuditExportOptions = {}): Promise<{ count: number; output?: string }> {
  const format = (options.format ?? 'jsonl').toLowerCase() as AuditExportFormat;
  if (!FORMATS.includes(format)) throw new UsageError(`Unsupported format "${options.format}".`, { hint: 'Use --format jsonl, csv or ocsf.' });

  const records = getTelemetry().readAudit(options.since ? parseSince(options.since) : undefined);
  const content = formatAuditRecords(records, format);

  if (options.output) {
    const target = path.resolve(options.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
    logger.success(`✔ Exported ${records.length} audit record(s) to ${target}`);
    return { count: records.length, output: target };
  }
  emitData(content);
  return { count: records.length };
}
