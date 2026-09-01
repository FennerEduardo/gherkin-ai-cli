import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { getGlobalUserLocale } from './i18n-cli';

export async function resolveWorkspaceDirectory(): Promise<void> {
  const cwd = process.cwd();
  const subProjects: { name: string, value: string }[] = [];

  // Look for subdirectories with .git
  const entries = fs.readdirSync(cwd, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      const subDir = path.join(cwd, entry.name);
      if (fs.existsSync(path.join(subDir, '.git')) || fs.existsSync(path.join(subDir, 'package.json'))) {
        subProjects.push({
          name: entry.name,
          value: subDir
        });
      }
    }
  }

  // Also check if current directory has a workspace definition (package.json workspaces, nx.json, lerna.json)
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkg.workspaces && Array.isArray(pkg.workspaces)) {
        // Just note that it's a workspace, the subProjects above should have caught the folders with package.json
      } else {
        // If it's a regular project (has package.json but no workspaces) and we didn't find multiple projects, return early.
        // If we found only one subproject, but we are in a project root, we might want to just proceed in current root.
      }
    } catch {}
  }

  // If we found multiple projects, and the current directory itself is not a clear single project, we prompt.
  // We'll prompt if we find more than 0 sub-projects and current directory isn't obviously the only project we want.
  // Actually, if we are in a root that has multiple sub-repos, let's ask.
  if (subProjects.length > 0) {
    // Add current directory as an option just in case
    subProjects.unshift({ name: `[Current Directory] ${path.basename(cwd)}`, value: cwd });
    
    // Check if we have multiple true sub-projects
    if (subProjects.length > 1) {
      const locale = getGlobalUserLocale();
      const questionText = locale === 'es' 
        ? 'Múltiples proyectos detectados. ¿Sobre cuál deseas ejecutar Gherkin AI?'
        : 'Multiple projects detected. Which one do you want to run Gherkin AI on?';

      const answers = await inquirer.prompt([{
        type: 'list',
        name: 'targetDir',
        message: questionText,
        choices: subProjects,
      }]);

      if (answers.targetDir && answers.targetDir !== cwd) {
        process.chdir(answers.targetDir);
      }
    }
  }
}
