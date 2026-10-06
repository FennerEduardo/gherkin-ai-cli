/* ==========================================================================
   gherkin-ai-cli - Gitignore Management Utility
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { fileExistsSync, readFileSync, writeFileSync } from './file-system';
import { logger } from './logger';

const GHK_DEFAULT_IGNORES = [
  '.ghe/',
  '.gherkin-ai/',
  '*.log',
  '*.jsonl',
  'telemetry.jsonl',
  '.env',
  '.env.local'
];

/**
 * Build outputs of the generated stacks. Kept narrow on purpose: Rails keeps real code in bin/,
 * so only the .NET bin/Debug and bin/Release folders are ignored.
 */
const BUILD_OUTPUT_IGNORES = [
  'target/',
  'build/',
  '.gradle/',
  '**/bin/Debug/',
  '**/bin/Release/',
  '**/obj/',
  '_build/',
  'deps/',
  '.dart_tool/',
  '__pycache__/',
  '.pytest_cache/',
  '.next/',
  'dist/'
];

export function ensureGitignore(workspaceDir: string = process.cwd()): string {
  const gitignorePath = path.join(workspaceDir, '.gitignore');
  
  if (!fileExistsSync(gitignorePath)) {
    const content = `# gherkin-ai CLI Logs, Telemetry & Secrets
.ghe/
.gherkin-ai/
*.log
*.jsonl
telemetry.jsonl
.env
.env.local
.env.*.local

# Dependencies & Testing Artifacts
node_modules/
vendor/
coverage/

# Build outputs
${BUILD_OUTPUT_IGNORES.join('\n')}

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
  const missingBuild = BUILD_OUTPUT_IGNORES.filter(entry => !lines.includes(entry));

  if (missing.length > 0 || missingBuild.length > 0) {
    let appendContent = '';
    if (missing.length) appendContent += '\n# gherkin-ai CLI Logs, Telemetry & Secrets\n' + missing.map(m => `${m}\n`).join('');
    if (missingBuild.length) appendContent += '\n# Build outputs\n' + missingBuild.map(m => `${m}\n`).join('');
    writeFileSync(gitignorePath, existingContent.replace(/\n*$/, '\n') + appendContent);
    missing.push(...missingBuild);
    logger.info(`Updated existing .gitignore with missing entries (${missing.join(', ')}) at: ${gitignorePath}`);
  }

  return gitignorePath;
}
