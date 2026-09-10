/* ==========================================================================
   gherkin-ai-cli - AI Agent Action Log Engine
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getAuthorDetails, AuthorDetails } from './inventory';


export interface AgentLogRecord {
  logId: string;
  timestamp: string;
  featureName: string;
  action: string;
  agentId: AuthorDetails;
}

export class AgentLogManager {
  private logPath: string;

  constructor(workspaceDir: string = process.cwd()) {
    // Save internally in .ghe/agent_logs.json
    this.logPath = path.join(workspaceDir, '.ghe', 'agent_logs.json');
  }

  public getLogs(filterFeature?: string): AgentLogRecord[] {
    let records: AgentLogRecord[] = [];

    if (!fs.existsSync(this.logPath)) {
      return [];
    }

    try {
      const data = fs.readFileSync(this.logPath, 'utf8');
      records = JSON.parse(data);
    } catch {
      records = [];
    }

    if (filterFeature) {
      const normTarget = path.normalize(filterFeature).toLowerCase();
      records = records.filter(r => 
        r.featureName.toLowerCase().includes(normTarget) ||
        r.action.toLowerCase().includes(normTarget)
      );
    }

    return records;
  }

  public recordAction(featureName: string, action: string): AgentLogRecord {
    const timestamp = new Date().toISOString();
    const logId = `act_${Date.now()}`;
    const agentId = getAuthorDetails();
    
    const record: AgentLogRecord = {
      logId,
      timestamp,
      featureName,
      action,
      agentId
    };

    const existing = this.getLogs();
    const maxEntries = 500; // Agent logs can be chatty
    
    const updated = [record, ...existing].slice(0, maxEntries);
    this.saveLogs(updated);
    return record;
  }

  public clearLogs(): void {
    if (fs.existsSync(this.logPath)) {
      try { fs.unlinkSync(this.logPath); } catch {}
    }
  }

  private saveLogs(records: AgentLogRecord[]): void {
    const content = JSON.stringify(records, null, 2);
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
    try { fs.writeFileSync(this.logPath, content, 'utf8'); } catch {}
  }

  public formatCLIReport(records: AgentLogRecord[]): string {
    if (records.length === 0) {
      return chalk.yellow('\nℹ No agent action logs found.\n');
    }

    let output = chalk.bold.magenta(`\n🤖 AI AGENT ACTION WALKTHROUGH LOG\n`);
    output += chalk.gray('========================================================================================\n');

    // Group logs by feature
    const grouped = records.reduce((acc, curr) => {
      if (!acc[curr.featureName]) acc[curr.featureName] = [];
      acc[curr.featureName].push(curr);
      return acc;
    }, {} as Record<string, AgentLogRecord[]>);

    for (const [feature, logs] of Object.entries(grouped)) {
      output += chalk.bold.cyan(`\n📂 Feature: ${feature}\n`);
      logs.forEach((r) => {
        output += `  ${chalk.gray(new Date(r.timestamp).toLocaleString())} - ${chalk.yellow(r.agentId.name)}\n`;
        output += `    ↳ ${chalk.white(r.action)}\n`;
      });
    }

    output += chalk.gray('\n========================================================================================\n');
    return output;
  }
}
