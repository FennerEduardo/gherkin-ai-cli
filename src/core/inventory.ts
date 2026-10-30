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

/** A file written by `ghk generate`, with the checksum of the content it wrote. */
export interface ArtifactEntry {
  filePath: string;
  type?: string;
  checksum?: string;
  /** Feature file that last produced it. */
  feature?: string;
  generatedAt?: string;
  /** Checksum of a generated version the user declined in `ghk generate --review` (not offered again). */
  declined?: string;
  /** Not written by the last run (generation.exclude, or scaffolding in an implemented project). */
  skipped?: boolean;
}

export interface FeatureRecord {
  checksum: string;
  /** Contract file (relative to outputDir) → sha256 on disk after the run. */
  contracts: Record<string, string>;
}

/**
 * `.ghe/inventory.json`. One file holds both the generated-artifact checksums (used by
 * `ghk upgrade` to prove a file is untouched) and the prompt-execution audit records
 * (`ghk implement`, `ghk audit`). Earlier versions wrote either a bare array of records
 * or `{ version: '1.0', artifacts }`; both are read and upgraded on the next write.
 */
export interface InventoryFile {
  version: '2';
  /** CLI version of the last `ghk generate` (since 3.2.1; earlier inventories have none). */
  cliVersion?: string;
  /**
   * Each feature file (project-relative path) as it was when last generated from (since 3.2.1): its sha256,
   * and the sha256 of its contract files as they were on disk right after that run.
   */
  features?: Record<string, FeatureRecord>;
  artifacts: ArtifactEntry[];
  executions: InventoryRecord[];
}

export function readInventoryFile(file: string): InventoryFile {
  const empty: InventoryFile = { version: '2', artifacts: [], executions: [] };
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty;
  }
  if (Array.isArray(json)) return { ...empty, executions: json.filter(r => r && typeof r === 'object' && typeof r.featurePath === 'string') };
  if (json && typeof json === 'object') {
    const obj = json as Partial<InventoryFile>;
    return {
      version: '2',
      ...(typeof obj.cliVersion === 'string' ? { cliVersion: obj.cliVersion } : {}),
      ...(obj.features && typeof obj.features === 'object' ? { features: obj.features } : {}),
      artifacts: Array.isArray(obj.artifacts) ? obj.artifacts.filter(a => a && typeof a.filePath === 'string') : [],
      executions: Array.isArray(obj.executions) ? obj.executions : []
    };
  }
  return empty;
}

export function writeInventoryFile(file: string, inventory: InventoryFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // One key order whatever the previous file had, so rewriting the same inventory changes nothing in git.
  const { version, cliVersion, features, artifacts, executions, ...rest } = inventory;
  const ordered = { version, ...(cliVersion ? { cliVersion } : {}), ...(features ? { features } : {}), artifacts, executions, ...rest };
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

/** Adds or replaces artifact entries by path; entries of other features are kept. */
export function mergeArtifacts(existing: ArtifactEntry[], incoming: ArtifactEntry[]): ArtifactEntry[] {
  const byPath = new Map(existing.map(a => [a.filePath.replace(/\\/g, '/'), a]));
  for (const a of incoming) byPath.set(a.filePath.replace(/\\/g, '/'), { ...a, filePath: a.filePath.replace(/\\/g, '/') });
  return [...byPath.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
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
    records = readInventoryFile(sourcePath).executions;

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

  /** Clears the execution records. Artifact checksums are kept: `ghk upgrade` needs them. */
  public clearInventory(): void {
    this.saveInventory([]);
    if (fs.existsSync(this.specsInventoryPath)) {
      try { fs.unlinkSync(this.specsInventoryPath); } catch {}
    }
  }

  private saveInventory(records: InventoryRecord[]): void {
    // Only the execution records are owned here; artifacts written by `ghk generate` are preserved.
    const inventory = { ...readInventoryFile(this.gheInventoryPath), executions: records };
    try { writeInventoryFile(this.gheInventoryPath, inventory); } catch {}

    // Only mirror to generated-specs/inventory.json if explicitly configured
    if (this.config.audit?.persistInGit === true) {
      const specsDir = path.dirname(this.specsInventoryPath);
      if (fs.existsSync(specsDir)) {
        try { writeInventoryFile(this.specsInventoryPath, inventory); } catch {}
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
