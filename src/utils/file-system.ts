/* ==========================================================================
   gherkin-ai-cli - File System Helper Utility
   ========================================================================== */

import fs from 'fs';
import path from 'path';

export function resolveSafePath(base: string, target: string): string {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(base, target);
  
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error(`Security Violation: Path traversal attempt blocked. Target '${target}' resolves outside of base directory '${resolvedBase}'`);
  }
  return resolvedTarget;
}

export function ensureDirSync(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function writeFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Writes a generated file. Scripts (content starting with a shebang, e.g. bin/rails, validate.sh)
 * are made executable, so generated projects run on Linux and macOS without a manual chmod.
 */
export function writeGeneratedFile(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  if (content.startsWith('#!')) fs.chmodSync(filePath, 0o755);
}

export function readFileSync(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function fileExistsSync(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function removeFileSync(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function removeDirSync(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}
