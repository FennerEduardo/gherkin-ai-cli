/* ==========================================================================
   gherkin-ai-cli - File System Helper Utility
   ========================================================================== */

import fs from 'fs';
import path from 'path';

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

export function readFileSync(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function fileExistsSync(filePath: string): boolean {
  return fs.existsSync(filePath);
}
