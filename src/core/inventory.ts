/* ==========================================================================
   gherkin-ai-cli - Feature Inventory & Prompt Execution Audit Trail Engine
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig, GherkinAIConfig } from './config';
import { logger } from '../utils/logger';

export interface AuthorDetails {
  name: string;
  email: string;
  source: 'git' | 'env' | 'fallback';
}

export interface InventoryRecord {
  recordId: string;
  timestamp: string;
  featureName: string;
  featurePath: string;
  featureVersionHash: string;
  promptVersionHash: string;
  author: AuthorDetails;
  command: string;
  stack: {
    language: string;
    framework: string;
    architecture: string;
    testing: string;
  };
  dockerSandbox: boolean;
  dockerImage?: string;
  status: 'PROMPT_GENERATED' | 'IMPLEMENTED' | 'VERIFIED';
}

let cachedAuthorDetails: AuthorDetails | null = null;

export function getAuthorDetails(): AuthorDetails {
  if (cachedAuthorDetails) {
    return cachedAuthorDetails;
  }

  if (process.env.GHK_AUTHOR_NAME || process.env.GHK_AUTHOR_EMAIL) {
    cachedAuthorDetails = {
      name: process.env.GHK_AUTHOR_NAME || 'Unknown Developer',
      email: process.env.GHK_AUTHOR_EMAIL || 'dev@local',
      source: 'env'
    };
    return cachedAuthorDetails;
  }

  try {
    const name = execSync('git config user.name', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const email = execSync('git config user.email', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (name || email) {
      cachedAuthorDetails = {
        name: name || 'Git Developer',
        email: email || 'git@local',
        source: 'git'
      };
      return cachedAuthorDetails;
    }
  } catch {
    // Git command unavailable or non-git directory
  }

  const osUser = process.env.USER || process.env.USERNAME || process.env.LOGNAME || 'Developer';
  cachedAuthorDetails = {
    name: osUser,
    email: `${osUser.toLowerCase().replace(/[^a-z0-9]/g, '')}@localhost`,
    source: 'fallback'
  };
  return cachedAuthorDetails;
}


export function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
}

export class InventoryManager {
  private gheInventoryPath: string;
  private specsInventoryPath: string;
  private config: GherkinAIConfig;

  constructor(workspaceDir: string = process.cwd(), customConfig?: GherkinAIConfig) {
    this.gheInventoryPath = path.join(workspaceDir, '.ghe', 'inventory.json');
    this.specsInventoryPath = path.join(workspaceDir, 'generated-specs', 'inventory.json');
    this.config = customConfig || loadConfig(path.join(workspaceDir, 'gherkin-ai.config.json'));
  }

  public isAuditEnabled(): boolean {
    if (process.env.GHK_AUDIT_ENABLED === 'false') return false;
    return this.config.audit?.enabled !== false;
  }

  public getInventory(filterFeaturePath?: string): InventoryRecord[] {
    let records: InventoryRecord[] = [];
    const sourcePath = fs.existsSync(this.gheInventoryPath)
      ? this.gheInventoryPath
      : (fs.existsSync(this.specsInventoryPath) ? this.specsInventoryPath : undefined);

    if (!sourcePath) return [];

    try {
      const data = fs.readFileSync(sourcePath, 'utf8');
      records = JSON.parse(data);
    } catch {
      records = [];
    }

    if (filterFeaturePath) {
      const normTarget = path.normalize(filterFeaturePath).toLowerCase();
      records = records.filter(r => 
        path.normalize(r.featurePath).toLowerCase().includes(normTarget) ||
        r.featureName.toLowerCase().includes(normTarget)
      );
    }

    return records;
  }

  public recordExecution(entry: Omit<InventoryRecord, 'recordId' | 'timestamp'>): InventoryRecord | null {
    if (!this.isAuditEnabled()) {
      logger.info('ℹ Feature audit tracking is disabled in configuration.');
      return null;
    }

    const timestamp = new Date().toISOString();
    const recordId = `rec_${Date.now()}_${calculateHash(entry.featurePath + timestamp)}`;
    
    const record: InventoryRecord = {
      recordId,
      timestamp,
      ...entry
    };

    const maxEntries = this.config.audit?.maxEntries || 50;
    const existing = this.getInventory();
    
    // Retention rotation: cap entries at maxEntries to prevent file bloating
    const updated = [record, ...existing].slice(0, maxEntries);

    this.saveInventory(updated);
    return record;
  }

  public clearInventory(): void {
    if (fs.existsSync(this.gheInventoryPath)) {
      try { fs.unlinkSync(this.gheInventoryPath); } catch {}
    }
    if (fs.existsSync(this.specsInventoryPath)) {
      try { fs.unlinkSync(this.specsInventoryPath); } catch {}
    }
  }

  private saveInventory(records: InventoryRecord[]): void {
    const content = JSON.stringify(records, null, 2);

    // Save internally in .ghe/inventory.json (keeps root clean)
    const gheDir = path.dirname(this.gheInventoryPath);
    if (!fs.existsSync(gheDir)) {
      try { fs.mkdirSync(gheDir, { recursive: true }); } catch {}
    }
    try { fs.writeFileSync(this.gheInventoryPath, content, 'utf8'); } catch {}

    // Only mirror to generated-specs/inventory.json if explicitly configured
    if (this.config.audit?.persistInGit === true) {
      const specsDir = path.dirname(this.specsInventoryPath);
      if (fs.existsSync(specsDir)) {
        try { fs.writeFileSync(this.specsInventoryPath, content, 'utf8'); } catch {}
      }
    }
  }

  public formatCLIReport(records: InventoryRecord[]): string {
    if (!this.isAuditEnabled()) {
      return chalk.yellow('\nℹ Audit tracking is disabled in gherkin-ai.config.json ("audit": { "enabled": false }).\n');
    }

    if (records.length === 0) {
      return chalk.yellow('\nℹ No feature implementation audit records found in inventory.\n');
    }

    const maxEntries = this.config.audit?.maxEntries || 50;
    let output = chalk.bold.cyan(`\n📋 FEATURE IMPLEMENTATION & PROMPT EXECUTION INVENTORY AUDIT (Max Retention: ${maxEntries})\n`);
    output += chalk.gray('========================================================================================\n');

    records.forEach((r, idx) => {
      output += `${chalk.bold.yellow(`#${idx + 1}`)} ${chalk.bold.white(r.featureName)} (${chalk.cyan(r.status)})\n`;
      output += `   📂 ${chalk.white('Feature Spec')}:     ${r.featurePath} (Hash: ${chalk.green(r.featureVersionHash)})\n`;
      output += `   🔐 ${chalk.white('Prompt Hash')}:      ${r.promptVersionHash}\n`;
      output += `   👤 ${chalk.white('Author / Dev')}:     ${r.author.name} <${r.author.email}> [via ${r.author.source}]\n`;
      output += `   🛠️ ${chalk.white('Stack Context')}:    ${r.stack.language.toUpperCase()} (${r.stack.framework}) | ${r.stack.architecture.toUpperCase()}\n`;
      output += `   🐳 ${chalk.white('Docker Sandbox')}:   ${r.dockerSandbox ? chalk.green(`Yes (${r.dockerImage || 'Enabled'})`) : chalk.gray('No')}\n`;
      output += `   🕒 ${chalk.white('Executed At')}:      ${new Date(r.timestamp).toLocaleString()}\n`;
      output += `   🆔 ${chalk.white('Record ID')}:        ${r.recordId}\n`;
      output += chalk.gray('----------------------------------------------------------------------------------------\n');
    });

    return output;
  }
}
