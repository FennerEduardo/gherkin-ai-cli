/* ==========================================================================
   gherkin-ai-cli - The other aggregates of a multi-feature service

   Service-wide files (the runtime command service registry, NestJS
   AppModule, Python domain package, Rust domain module, ...) must cover
   every feature of the project, not only the one being generated. A sibling
   is included once its domain kernel exists in the output directory, so a
   service-wide file never references code that has not been generated yet.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { GherkinAIConfig } from '../../core/config';
import { parseGherkinText, type ParsedFeature } from '../../core/gherkin-parser';
import { projectFeatureFiles } from '../../core/workspace-projects';
import { buildDomainModel, type DomainModel } from './domain-model';

/**
 * Domain models of the project's other features whose domain file (`domainFile(model)`, relative to
 * outputDir) already exists, sorted by name. Empty outside a gherkin-ai project.
 */
export function siblingDomainModels(
  current: DomainModel,
  config: Pick<GherkinAIConfig, 'projectName' | 'outputDir'> | undefined,
  domainFile: (m: DomainModel) => string,
  cwd = process.cwd()
): DomainModel[] {
  let files: string[] = [];
  try { files = projectFeatureFiles(cwd); } catch { return []; }
  const outDir = path.resolve(cwd, config?.outputDir || './');
  const byName = new Map<string, DomainModel>();
  for (const file of files) {
    let parsed: ParsedFeature;
    try { parsed = parseGherkinText(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const m = buildDomainModel(parsed, { service: config?.projectName });
    if (m.pascal === current.pascal || byName.has(m.pascal)) continue;
    if (fs.existsSync(path.join(outDir, domainFile(m)))) byName.set(m.pascal, m);
  }
  return [...byName.keys()].sort().map(k => byName.get(k) as DomainModel);
}
