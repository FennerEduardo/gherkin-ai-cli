/* ==========================================================================
   gherkin-ai-cli - Gitignore Management Utility
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { fileExistsSync, readFileSync, writeFileSync } from './file-system';
import { logger } from './logger';

const GHK_DEFAULT_IGNORES = [
  '.ghe/',
  '*.log',
  '.env',
  '.env.local'
];

export function ensureGitignore(workspaceDir: string = process.cwd()): string {
  const gitignorePath = path.join(workspaceDir, '.gitignore');
  
  if (!fileExistsSync(gitignorePath)) {
    const content = `# gherkin-ai CLI Logs & Environment Secrets
.ghe/
*.log
.env
.env.local
.env.*.local

# Dependencies & Testing Artifacts
node_modules/
vendor/
coverage/

# OS Files
.DS_Store
Thumbs.db
`;
    writeFileSync(gitignorePath, content);
    logger.success(`Created .gitignore with gherkin-ai guardrails at: ${gitignorePath}`);
    return gitignorePath;
  }

  // File exists: clean up any accidental 'generated-specs/' lines and append missing ignores
  let existingContent = readFileSync(gitignorePath);
  
  // Remove 'generated-specs/' if previously added, so domain contracts are tracked in Git
  if (existingContent.includes('generated-specs/')) {
    existingContent = existingContent
      .split(/\r?\n/)
      .filter(line => line.trim() !== 'generated-specs/' && line.trim() !== 'generated-specs')
      .join('\n');
    writeFileSync(gitignorePath, existingContent);
    logger.info(`Removed "generated-specs/" from .gitignore so contracts are tracked in Git at: ${gitignorePath}`);
  }

  const lines = existingContent.split(/\r?\n/).map(l => l.trim());
  const missing = GHK_DEFAULT_IGNORES.filter(entry => !lines.includes(entry));

  if (missing.length > 0) {
    let appendContent = '\n# gherkin-ai CLI Logs & Secrets\n';
    missing.forEach(m => {
      appendContent += `${m}\n`;
    });
    writeFileSync(gitignorePath, existingContent + appendContent);
    logger.info(`Updated existing .gitignore with missing entries (${missing.join(', ')}) at: ${gitignorePath}`);
  }

  return gitignorePath;
}
