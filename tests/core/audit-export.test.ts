import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatAuditRecords, parseSince } from '../../src/commands/audit-export';
import { TelemetryManager, AuditLogEntry } from '../../src/core/telemetry';
import { UsageError } from '../../src/core/errors';

const entry = (overrides: Partial<AuditLogEntry>): AuditLogEntry => ({
  timestamp: '2026-10-01T10:00:00.000Z', executionId: 'e1', version: '3.0.0', user: 'dev', host: 'h', source: 'cli', action: 'llm:call', status: 'SUCCESS', ...overrides
});

describe('audit export', () => {
  it('parses relative windows and ISO dates', () => {
    const now = Date.parse('2026-10-02T00:00:00Z');
    expect(parseSince('24h', now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(parseSince('7d', now).toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(parseSince('2026-09-30').toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(() => parseSince('yesterday')).toThrow(UsageError);
  });

  it('writes CSV with escaping and neutralizes spreadsheet formulas', () => {
    const csv = formatAuditRecords([entry({ details: 'a, "quoted"\nline', resource: '=HYPERLINK("http://x")' })], 'csv');
    const [header, row] = csv.split('\n');
    expect(header).toBe('timestamp,executionId,version,user,host,source,action,resource,status,details');
    expect(row).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain('"a, ""quoted""\nline"');
  });

  it('filters records by --since and skips malformed lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-audit-'));
    const manager = new TelemetryManager(dir);
    fs.mkdirSync(path.dirname(manager.auditPath), { recursive: true });
    fs.writeFileSync(manager.auditPath, [
      JSON.stringify(entry({ timestamp: '2026-09-01T00:00:00.000Z', action: 'old' })),
      'not json',
      JSON.stringify(entry({ timestamp: '2026-10-01T00:00:00.000Z', action: 'new' }))
    ].join('\n'));
    expect(manager.readAudit().map(r => r.action)).toEqual(['old', 'new']);
    expect(manager.readAudit(new Date('2026-09-15')).map(r => r.action)).toEqual(['new']);
    expect(formatAuditRecords(manager.readAudit(), 'jsonl').trim().split('\n')).toHaveLength(2);
  });
});
