/* ==========================================================================
   gherkin-ai-cli - Deterministic Spec & Contract SHA-256 Hash Baseline
   ========================================================================== */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface BaselineEntry {
  filePath: string;
  hash: string;
  updatedAt: string;
}

export interface BaselineManifest {
  version: string;
  entries: Record<string, BaselineEntry>;
}

export interface SpecDriftCheckResult {
  hasDrift: boolean;
  untrackedFiles: string[];
  modifiedFiles: string[];
  intactFiles: string[];
}

export class SpecHashBaseline {
  private baselinePath: string;

  constructor(workspaceDir: string) {
    const ghkDir = path.join(workspaceDir, '.ghk');
    if (!fs.existsSync(ghkDir)) {
      fs.mkdirSync(ghkDir, { recursive: true });
    }
    this.baselinePath = path.join(ghkDir, 'baselines.json');
  }

  /**
   * Calculates SHA-256 hash of string content or file
   */
  public static calculateHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Loads current baseline manifest
   */
  public loadManifest(): BaselineManifest {
    if (!fs.existsSync(this.baselinePath)) {
      return { version: '1.0', entries: {} };
    }
    try {
      const data = fs.readFileSync(this.baselinePath, 'utf8');
      return JSON.parse(data) as BaselineManifest;
    } catch {
      return { version: '1.0', entries: {} };
    }
  }

  /**
   * Saves or updates baseline entries for a list of files
   */
  public updateBaselines(filePaths: string[]): BaselineManifest {
    const manifest = this.loadManifest();
    const now = new Date().toISOString();

    for (const filePath of filePaths) {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const hash = SpecHashBaseline.calculateHash(content);
        const relativePath = path.relative(process.cwd(), filePath);
        manifest.entries[relativePath] = {
          filePath: relativePath,
          hash,
          updatedAt: now
        };
      }
    }

    fs.writeFileSync(this.baselinePath, JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  /**
   * Verifies current files against stored baseline manifest
   */
  public verifyDrift(filePaths: string[]): SpecDriftCheckResult {
    const manifest = this.loadManifest();
    const result: SpecDriftCheckResult = {
      hasDrift: false,
      untrackedFiles: [],
      modifiedFiles: [],
      intactFiles: []
    };

    for (const filePath of filePaths) {
      const relativePath = path.relative(process.cwd(), filePath);
      const entry = manifest.entries[relativePath];

      if (!entry) {
        result.untrackedFiles.push(relativePath);
        result.hasDrift = true;
        continue;
      }

      if (!fs.existsSync(filePath)) {
        result.modifiedFiles.push(relativePath);
        result.hasDrift = true;
        continue;
      }

      const currentContent = fs.readFileSync(filePath, 'utf8');
      const currentHash = SpecHashBaseline.calculateHash(currentContent);

      if (currentHash !== entry.hash) {
        result.modifiedFiles.push(relativePath);
        result.hasDrift = true;
      } else {
        result.intactFiles.push(relativePath);
      }
    }

    return result;
  }
}
