/* ==========================================================================
   gherkin-ai-cli - Local telemetry & audit trail

   Everything stays on the machine; nothing is ever sent remotely.

   - telemetry.jsonl: one event per command / LLM call / MCP tool call
     (duration, exit code, tokens). Disable with telemetry.enabled=false or
     GHK_TELEMETRY_DISABLED=true.
   - audit.jsonl: security-relevant actions (file writes by agents, LLM calls,
     MCP operations, policy denials). Controlled by audit.enabled (default
     true; organizations can lock it). Export with `ghk audit export`.

   Both live in telemetry.dir (default <workspace>/.gherkin-ai/), are
   append-only JSONL and redacted.
   ========================================================================== */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CLI_VERSION } from '../version';
import { redactSensitive } from './security';

export type TelemetryEventType = 'COMMAND_EXECUTION' | 'LLM_CALL' | 'MCP_TOOL_CALL' | 'GUARDRAIL_VIOLATION' | 'AGENT_HEALING' | 'SPEC_LINT' | 'CONVERGENCE_CHECK';

export interface TelemetryEvent {
  eventId: string;
  timestamp: string;
  executionId: string;
  version: string;
  eventType: TelemetryEventType;
  commandName?: string;
  durationMs?: number;
  exitCode?: number;
  qualityScore?: number;
  convergenceScore?: number;
  success: boolean;
  metadata?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  modelUsed?: string;
  provider?: string;
}

export type AuditStatus = 'SUCCESS' | 'BLOCKED' | 'FAILED';

export interface AuditLogEntry {
  timestamp: string;
  executionId: string;
  version: string;
  user: string;
  host: string;
  source: 'cli' | 'mcp' | 'web';
  action: string;
  resource?: string;
  status: AuditStatus;
  details?: string;
  role?: string;
}

/** One id per CLI process, shared by logs, telemetry and audit records. */
export const EXECUTION_ID = crypto.randomUUID();

export interface TelemetryOptions {
  dir?: string;
  telemetryEnabled?: boolean;
  auditEnabled?: boolean;
}

function gitUser(): string | undefined {
  return process.env.GHK_AUTHOR_EMAIL || process.env.GHK_AUTHOR_NAME || undefined;
}

export class TelemetryManager {
  private readonly dir: string;
  private readonly telemetryFile: string;
  private readonly auditFile: string;
  private readonly telemetryEnabled: boolean;
  private readonly auditEnabled: boolean;

  constructor(cwd: string = process.cwd(), options: TelemetryOptions = {}) {
    this.dir = options.dir ? path.resolve(cwd, options.dir) : path.join(cwd, '.gherkin-ai');
    this.telemetryFile = path.join(this.dir, 'telemetry.jsonl');
    this.auditFile = path.join(this.dir, 'audit.jsonl');
    const envDisabled = process.env.GHK_TELEMETRY_DISABLED === 'true' || process.env.GHK_TELEMETRY_DISABLED === '1';
    this.telemetryEnabled = (options.telemetryEnabled ?? true) && !envDisabled;
    this.auditEnabled = options.auditEnabled ?? true;
  }

  get auditPath(): string {
    return this.auditFile;
  }

  get telemetryPath(): string {
    return this.telemetryFile;
  }

  private append(file: string, record: unknown): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Telemetry and audit must never break a command.
    }
  }

  public recordEvent(event: Omit<TelemetryEvent, 'eventId' | 'timestamp' | 'executionId' | 'version'>): TelemetryEvent {
    const full: TelemetryEvent = {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      executionId: EXECUTION_ID,
      version: CLI_VERSION,
      ...event
    };
    if (this.telemetryEnabled) this.append(this.telemetryFile, full);
    return full;
  }

  public recordAudit(entry: Pick<AuditLogEntry, 'action' | 'status'> & Partial<Omit<AuditLogEntry, 'timestamp' | 'executionId' | 'version'>>): AuditLogEntry {
    const full: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      executionId: EXECUTION_ID,
      version: CLI_VERSION,
      user: gitUser() || process.env.USER || process.env.USERNAME || os.userInfo().username || 'unknown',
      host: os.hostname(),
      source: 'cli',
      ...entry,
      details: entry.details ? redactSensitive(entry.details) : undefined
    };
    if (this.auditEnabled) this.append(this.auditFile, full);
    return full;
  }

  /** Reads audit records, optionally only those at or after `since`. Malformed lines are skipped. */
  public readAudit(since?: Date): AuditLogEntry[] {
    if (!fs.existsSync(this.auditFile)) return [];
    const records: AuditLogEntry[] = [];
    for (const line of fs.readFileSync(this.auditFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as AuditLogEntry;
        if (!since || new Date(record.timestamp) >= since) records.push(record);
      } catch {
        // skip
      }
    }
    return records;
  }

  public getSummary(): { totalEvents: number; averageConvergenceScore: number; guardrailViolations: number; totalInputTokens: number; totalOutputTokens: number } {
    const summary = { totalEvents: 0, averageConvergenceScore: 0, guardrailViolations: 0, totalInputTokens: 0, totalOutputTokens: 0 };
    if (!fs.existsSync(this.telemetryFile)) return summary;
    let convergenceTotal = 0;
    let convergenceCount = 0;
    for (const line of fs.readFileSync(this.telemetryFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as TelemetryEvent;
        summary.totalEvents++;
        if (evt.convergenceScore !== undefined) {
          convergenceTotal += evt.convergenceScore;
          convergenceCount++;
        }
        if (evt.eventType === 'GUARDRAIL_VIOLATION') summary.guardrailViolations++;
        summary.totalInputTokens += evt.inputTokens ?? 0;
        summary.totalOutputTokens += evt.outputTokens ?? 0;
      } catch {
        // skip
      }
    }
    summary.averageConvergenceScore = convergenceCount ? Math.round(convergenceTotal / convergenceCount) : 0;
    return summary;
  }
}

let shared: TelemetryManager | undefined;

/** Process-wide manager configured from the resolved config (call configureTelemetry once at startup). */
export function getTelemetry(): TelemetryManager {
  shared ??= new TelemetryManager();
  return shared;
}

export function configureTelemetry(cwd: string, options: TelemetryOptions): TelemetryManager {
  shared = new TelemetryManager(cwd, options);
  return shared;
}
