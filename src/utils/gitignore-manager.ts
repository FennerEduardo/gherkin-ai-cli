/* ==========================================================================
   gherkin-ai-cli - Gitignore Management Utility
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { fileExistsSync, readFileSync, writeFileSync } from './file-system';
import { logger } from './logger';

// .gherkin-ai/ holds credentials (auth.json), logs and caches, but the constitution is the team's architecture
// policy (ghk init --enterprise) and is versioned: ignore the directory's contents, then re-include it.
const GHK_LOCAL_DIR = ['.gherkin-ai/*', '!.gherkin-ai/constitution.yaml'];

// .ghe/ is CLI state (caches, context bundles), but the inventory holds the checksums that prove a generated
// file is unedited. Without it, a fresh clone or a CI job cannot tell generated code from implemented code.
const GHE_DIR = ['.ghe/*', '!.ghe/inventory.json'];

const GHK_DEFAULT_IGNORES = [
  ...GHE_DIR,
  ...GHK_LOCAL_DIR,
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
${GHE_DIR.join('\n')}
${GHK_LOCAL_DIR.join('\n')}
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

  // Earlier versions ignored whole directories, which git cannot re-include from: switch to their contents.
  for (const [dir, entries] of [['.gherkin-ai', GHK_LOCAL_DIR], ['.ghe', GHE_DIR]] as const) {
    const whole = (l: string) => l.trim() === `${dir}/` || l.trim() === dir;
    if (existingContent.split(/\r?\n/).some(whole)) {
      existingContent = existingContent.split(/\r?\n/).map(l => (whole(l) ? entries.join('\n') : l)).join('\n');
      writeFileSync(gitignorePath, existingContent);
    }
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
