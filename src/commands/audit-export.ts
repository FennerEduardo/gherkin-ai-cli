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

export function formatAuditRecords(records: AuditLogEntry[], format: 'jsonl' | 'csv'): string {
  if (format === 'jsonl') return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  const rows = records.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

export async function handleAuditExportCommand(options: AuditExportOptions = {}): Promise<{ count: number; output?: string }> {
  const format = (options.format ?? 'jsonl').toLowerCase();
  if (format !== 'jsonl' && format !== 'csv') throw new UsageError(`Unsupported format "${options.format}".`, { hint: 'Use --format jsonl or --format csv.' });

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
