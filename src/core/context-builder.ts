/* ==========================================================================
   gherkin-ai-cli - Context Engineering & Bundle Builder (.ghe/ Engine)
   ========================================================================== */

import fs from 'fs';
import path from 'path';

export interface ProjectContextBundle {
  projectConfig?: any;
  architectureGuide?: string;
  conventionsGuide?: string;
  securityGuide?: string;
  detectedFiles: string[];
  builtAt: string;
}

export function buildProjectContext(workspaceDir: string = process.cwd()): ProjectContextBundle {
  const gheDir = path.join(workspaceDir, '.ghe');
  
  // Create .ghe structure if not existing
  if (!fs.existsSync(gheDir)) {
    fs.mkdirSync(gheDir, { recursive: true });
    fs.mkdirSync(path.join(gheDir, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(gheDir, 'agents'), { recursive: true });

    fs.writeFileSync(
      path.join(gheDir, 'project.yaml'),
      `name: gherkin-ai-project\nversion: 1.0.0\nenvironment: development\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(gheDir, 'conventions.md'),
      `# Project Coding Conventions\n- Follow Clean Code principles.\n- Write explicit unit tests for use cases.\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(gheDir, 'security.md'),
      `# Security Policies\n- Never hardcode secrets.\n- Sanitize all user inputs.\n`,
      'utf8'
    );
  }

  const readIfExists = (filePath: string): string | undefined => {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  };

  const detectedFiles: string[] = [];
  try {
    const listFilesRecursive = (dir: string, depth = 0) => {
      if (depth > 2) return;
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'dist') continue;
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          listFilesRecursive(fullPath, depth + 1);
        } else {
          detectedFiles.push(path.relative(workspaceDir, fullPath));
        }
      }
    };
    listFilesRecursive(workspaceDir);
  } catch (_) {}

  return {
    projectConfig: readIfExists(path.join(gheDir, 'project.yaml')),
    architectureGuide: readIfExists(path.join(gheDir, 'architecture.md')),
    conventionsGuide: readIfExists(path.join(gheDir, 'conventions.md')),
    securityGuide: readIfExists(path.join(gheDir, 'security.md')),
    detectedFiles: detectedFiles.slice(0, 50),
    builtAt: new Date().toISOString()
  };
}
