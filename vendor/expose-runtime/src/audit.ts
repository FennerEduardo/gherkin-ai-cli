/* Audit trail: one JSON line per decision, the same fields as gherkin-ai's audit.jsonl plus the trace and
 * the scenarios the tool comes from, so every call can be traced to its specification. Argument values are
 * never written, only their names. Ship the lines to CloudWatch, Azure Monitor or an OpenTelemetry
 * collector as logs. */

import { appendFileSync } from 'node:fs';

export interface AuditEvent {
  action: 'tool:list' | 'tool:call' | 'auth';
  status: 'SUCCESS' | 'BLOCKED' | 'FAILURE';
  resource?: string;
  user?: string;
  tenant?: string;
  client?: string;
  scenarios?: string[];
  features?: string[];
  traceId?: string;
  arguments?: string[];
  upstreamStatus?: number;
  durationMs?: number;
  details?: string;
}

export class AuditLog {
  constructor(private readonly service: string, private readonly environment: string, private readonly file?: string) {}

  record(event: AuditEvent): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), source: 'mcp-runtime', service: this.service, environment: this.environment, ...event }) + '\n';
    try {
      if (this.file) appendFileSync(this.file, line);
      else process.stdout.write(line);
    } catch {
      process.stderr.write('audit: could not write the audit line\n');
    }
  }
}
