/* ==========================================================================
   gherkin-ai-cli - Enterprise Telemetry & Audit Observability Layer
   
   Logs anonymous usage, execution audit trails, convergence metrics,
   and agent performance records to .gherkin-ai/telemetry.jsonl & audit.log.
   ========================================================================== */

import fs from 'fs';
import path from 'path';

export interface TelemetryEvent {
  eventId: string;
  timestamp: string;
  eventType: 'COMMAND_EXECUTION' | 'SPEC_LINT' | 'CONVERGENCE_CHECK' | 'MCP_TOOL_CALL' | 'GUARDRAIL_VIOLATION' | 'AGENT_HEALING';
  commandName?: string;
  durationMs?: number;
  qualityScore?: number;
  convergenceScore?: number;
  success: boolean;
  metadata?: Record<string, any>;
  inputTokens?: number;
  outputTokens?: number;
  modelUsed?: string;
}

export interface AuditLogEntry {
  timestamp: string;
  user?: string;
  role?: string;
  action: string;
  resource?: string;
  status: 'SUCCESS' | 'BLOCKED' | 'FAILED';
  details?: string;
}

export class TelemetryManager {
  private telemetryDir: string;
  private telemetryFile: string;
  private auditFile: string;
  private enabled: boolean;

  constructor(cwd: string = process.cwd()) {
    this.telemetryDir = path.join(cwd, '.gherkin-ai');
    this.telemetryFile = path.join(this.telemetryDir, 'telemetry.jsonl');
    this.auditFile = path.join(this.telemetryDir, 'audit.log');
    this.enabled = process.env.GHK_TELEMETRY_DISABLED !== 'true';
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.telemetryDir)) {
      try {
        fs.mkdirSync(this.telemetryDir, { recursive: true });
      } catch { }
    }
  }

  public recordEvent(event: Omit<TelemetryEvent, 'eventId' | 'timestamp'>): TelemetryEvent {
    const fullEvent: TelemetryEvent = {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...event
    };

    if (!this.enabled) return fullEvent;

    try {
      this.ensureDir();
      const line = JSON.stringify(fullEvent) + '\n';
      fs.appendFileSync(this.telemetryFile, line, 'utf8');
    } catch {
      // Non-blocking telemetry
    }

    return fullEvent;
  }

  public recordAudit(entry: Omit<AuditLogEntry, 'timestamp'>): void {
    const fullEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      user: process.env.USER || process.env.USERNAME || 'system',
      ...entry
    };

    try {
      this.ensureDir();
      const formatted = `[${fullEntry.timestamp}] [${fullEntry.status}] Role:${fullEntry.role || 'default'} Action:${fullEntry.action} Resource:${fullEntry.resource || '-'} Details:${fullEntry.details || '-'}\n`;
      fs.appendFileSync(this.auditFile, formatted, 'utf8');
    } catch {
      // Non-blocking audit log
    }
  }

  public getSummary(): { totalEvents: number; averageConvergenceScore: number; guardrailViolations: number; totalInputTokens: number; totalOutputTokens: number } {
    let totalEvents = 0;
    let totalConvergence = 0;
    let convergenceCount = 0;
    let guardrailViolations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    if (!fs.existsSync(this.telemetryFile)) {
      return { totalEvents: 0, averageConvergenceScore: 0, guardrailViolations: 0, totalInputTokens: 0, totalOutputTokens: 0 };
    }

    try {
      const content = fs.readFileSync(this.telemetryFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      totalEvents = lines.length;

      for (const line of lines) {
        try {
          const evt: TelemetryEvent = JSON.parse(line);
          if (evt.convergenceScore !== undefined) {
            totalConvergence += evt.convergenceScore;
            convergenceCount++;
          }
          if (evt.eventType === 'GUARDRAIL_VIOLATION') {
            guardrailViolations++;
          }
          if (evt.inputTokens) totalInputTokens += evt.inputTokens;
          if (evt.outputTokens) totalOutputTokens += evt.outputTokens;
        } catch { }
      }
    } catch { }

    return {
      totalEvents,
      averageConvergenceScore: convergenceCount > 0 ? Math.round(totalConvergence / convergenceCount) : 0,
      guardrailViolations,
      totalInputTokens,
      totalOutputTokens
    };
  }
}

export const telemetry = new TelemetryManager();
