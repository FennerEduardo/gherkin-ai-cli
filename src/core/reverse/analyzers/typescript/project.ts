/* ==========================================================================
   gherkin-ai-cli - One ts-morph project per analysed root, shared by the
   TypeScript adapters (Express, NestJS). Test files and declaration files
   are left out; tests are read separately as evidence (analyzers/tests).
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { Project } from 'ts-morph';
import { isTestFile } from '../../discovery';
import type { AnalysisContext } from '../../registry';

const projects = new Map<string, Project>();

export const TS_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);

export function tsSources(ctx: AnalysisContext) {
  return ctx.files.filter(f => TS_EXT.has(f.ext) && !f.rel.endsWith('.d.ts') && !isTestFile(f.rel) && !/(^|\/)(migrations?|seeds?)\//.test(f.rel));
}

export async function tsProject(ctx: AnalysisContext): Promise<Project> {
  const key = `${ctx.root}|${ctx.files.length}`;
  const cached = projects.get(key);
  if (cached) return cached;
  const { Project, ts } = await import('ts-morph');
  const project = new Project({
    compilerOptions: { allowJs: true, checkJs: false, noEmit: true, experimentalDecorators: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true
  });
  for (const f of tsSources(ctx)) project.addSourceFileAtPath(f.abs);
  projects.set(key, project);
  return project;
}

export function clearTsProjects(): void {
  projects.clear();
}

/** Dependencies of the package.json at the root (and of the analysed sub-directory's own). */
export function packageDeps(root: string): Set<string> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) for (const d of Object.keys(pkg[k] ?? {})) deps.add(d);
  } catch { /* no package.json */ }
  return deps;
}
