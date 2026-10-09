/* ==========================================================================
   gherkin-ai-cli - `ghk upgrade --kernel`: refresh the runtime kernel

   The runtime kernel (command service, outbox relay, inbox consumer, saga,
   telemetry and their integration test) is regenerated with the installed
   CLI. A kernel file is replaced only when it is unedited (its checksum
   matches the inventory); edited files get the new version as .ghk-new.
   Nothing else in the project is touched.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config';
import { parseGherkinText } from '../gherkin-parser';
import { buildIR } from '../ir-builder';
import { pluginRegistry } from '../plugin-system';
import { registerCorePlugins } from '../../plugins/core-generators-plugin';
import { readInventoryFile, writeInventoryFile, mergeArtifacts } from '../inventory';
import { planWrites, applyWrites, sha256, PlannedWrite } from '../write-protection';
import { projectFeatureFiles } from '../workspace-projects';
import { writeGeneratedFile } from '../../utils/file-system';

/** Runtime kernel files in every stack: a `runtime` directory or module, and the runtime integration test. */
export function isKernelFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return /(^|\/)runtime\//i.test(p) || /(^|\/)[^/]*runtime[_.-]?(int|integration)[^/]*$/i.test(p) || /RuntimeIntegration(Test|Tests|Spec)?\.\w+$/.test(p);
}

export interface KernelRefreshResult {
  project: string;
  plans: PlannedWrite[];
  error?: string;
}

/** Regenerates the kernel of the project in `projectDir` from its features and applies the safe writes. */
export function refreshKernel(projectDir: string, opts: { dryRun?: boolean } = {}): KernelRefreshResult {
  const previousCwd = process.cwd();
  // Generators resolve paths from the working directory (feature copies, contracts).
  process.chdir(projectDir);
  try {
    const config = loadConfig(path.join(projectDir, 'gherkin-ai.config.json'));
    const inventoryPath = path.join(projectDir, '.ghe', 'inventory.json');
    const inventory = readInventoryFile(inventoryPath);
    const features = projectFeatureFiles(projectDir).map(f => path.relative(projectDir, f).replace(/\\/g, '/'));
    if (!features.length) return { project: projectDir, plans: [], error: 'no feature files' };

    pluginRegistry.initialize({ config, constitution: null, projectDir });
    if (pluginRegistry.getPlugins().length === 0) registerCorePlugins(pluginRegistry);

    // A kernel file is regenerated from the feature that produced it last (inventory), else from the last feature.
    const featureOf = new Map(inventory.artifacts.filter(a => a.feature).map(a => [a.filePath.replace(/\\/g, '/'), a.feature as string]));
    const kernel = new Map<string, { filePath: string; content: string; type: string; feature: string }>();
    for (const feature of features) {
      const ir = buildIR(parseGherkinText(fs.readFileSync(path.join(projectDir, feature), 'utf8')), feature, { domainProfile: config.domainProfile });
      for (const a of pluginRegistry.runGeneration(ir, config)) {
        if (!isKernelFile(a.filePath)) continue;
        const owner = featureOf.get(a.filePath.replace(/\\/g, '/'));
        if (!kernel.has(a.filePath) || owner === feature || (!owner && feature === features[features.length - 1])) {
          kernel.set(a.filePath, { ...a, feature });
        }
      }
    }

    const artifacts = [...kernel.values()];
    const plans = planWrites(artifacts, { cwd: projectDir, outputDir: config.outputDir, inventory: inventory.artifacts, protect: config.generation?.protect });
    if (!opts.dryRun) {
      applyWrites(plans, new Map(artifacts.map(a => [a.filePath, a.content])), writeGeneratedFile);
      const generatedAt = new Date().toISOString();
      writeInventoryFile(inventoryPath, {
        ...inventory,
        artifacts: mergeArtifacts(inventory.artifacts, artifacts.map(a => ({ filePath: a.filePath, type: a.type, checksum: sha256(a.content), feature: a.feature, generatedAt })))
      });
    }
    return { project: projectDir, plans };
  } catch (e: any) {
    return { project: projectDir, plans: [], error: e.message };
  } finally {
    process.chdir(previousCwd);
  }
}
