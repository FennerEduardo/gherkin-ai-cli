import { emitJson } from '../utils/output';
import { ExitCode, GhkError, UsageError } from '../core/errors';
import { logger } from '../utils/logger';
import { analyzeImpact } from '../core/impact-analyzer';
import { resolveFeatureFile } from '../core/workspace-projects';

export interface ImpactCommandOptions {
  feature?: string;
  /** A source file: the scenarios that depend on it (PLAN-3.3.0-reverse-plus RV-17). */
  file?: string;
  json?: boolean;
}

/**
 * `ghk impact --file src/orders.js`: the scenarios that depend on a source file, through the repository graph: the
 * `# evidence:` comments of accepted reverse features, and the domain symbols the file mentions.
 */
async function fileImpact(file: string, json?: boolean): Promise<void> {
  const path = await import('path');
  const fs = await import('fs');
  const { buildRepositoryGraph } = await import('../core/graph/repository-graph');
  const root = process.cwd();
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (!fs.existsSync(path.join(root, rel))) throw new UsageError(`File not found: ${file}`);
  const graph = buildRepositoryGraph(root);
  const fileIds = new Set([`file:${rel}`, `test:${rel}`]);
  const direct = graph.edges.filter(e => fileIds.has(e.from));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const scenarios = new Map<string, { scenario: string; feature: string; via: 'evidence' | 'symbol' }>();
  for (const e of direct) {
    const n = byId.get(e.to);
    if (n?.kind === 'scenario') scenarios.set(n.id, { scenario: n.label, feature: n.id.replace(/^scenario:/, '').replace(/#.*$/, ''), via: 'evidence' });
    // A file linked to a command, event or feature by name reaches the scenarios that execute or declare it.
    if (n && n.kind !== 'scenario') {
      for (const back of graph.edges.filter(x => x.to === n.id || x.from === n.id)) {
        const other = byId.get(back.from === n.id ? back.to : back.from);
        if (other?.kind === 'scenario' && !scenarios.has(other.id)) scenarios.set(other.id, { scenario: other.label, feature: other.id.replace(/^scenario:/, '').replace(/#.*$/, ''), via: 'symbol' });
      }
    }
  }
  const list = [...scenarios.values()].sort((a, b) => a.feature.localeCompare(b.feature) || a.scenario.localeCompare(b.scenario));
  if (json) { emitJson({ file: rel, scenarios: list }); return; }
  logger.info(`${rel}: ${list.length} scenario(s) depend on it`);
  for (const s of list) console.log(`  ${s.via === 'evidence' ? '#' : '~'} ${s.feature} · ${s.scenario}`);
  if (list.some(s => s.via === 'evidence')) console.log('  # the scenario cites this file as evidence (ghk reverse); ~ the file mentions a symbol of the scenario');
}

export async function handleImpactCommand(options: ImpactCommandOptions): Promise<void> {
  if (options.file) { await fileImpact(options.file, options.json); return; }
  if (!options.json) {
    logger.banner();
    logger.info('Analyzing blast radius of specification changes...');
  }

  if (!options.feature) {
    throw new UsageError('Feature file is required. Use -f or --feature, or --file <source> for the scenarios that depend on a file.');
  }

  const featurePath = resolveFeatureFile(options.feature);

  try {
    const report = analyzeImpact(featurePath, process.cwd());

    if (options.json) {
      emitJson(report);
      return;
    }

    console.log('\n============================================================');
    console.log(`💥 BLAST RADIUS IMPACT REPORT: ${report.feature}`);
    console.log('============================================================\n');

    console.log(`Risk Level: ${getRiskBadge(report.riskLevel)}`);
    console.log(`Scenarios Affected Directly: ${report.affectedScenarios}\n`);

    console.log(`[Dependencies Detected]`);
    console.log(`- Downstream Features: ${report.affectedFeatures.length} file(s)`);
    if (report.affectedFeatures.length > 0) {
      report.affectedFeatures.forEach(f => console.log(`  └─ ${f}`));
    }

    console.log(`- Contracts/DTOs: ${report.affectedContracts.length} file(s)`);
    if (report.affectedContracts.length > 0) {
      report.affectedContracts.forEach(c => console.log(`  └─ ${c}`));
    }

    console.log(`- Schemas: ${report.affectedSchemas.length} file(s)`);
    console.log(`- API Endpoints/Swagger: ${report.affectedEndpoints.length} file(s)`);
    console.log(`- Test Suites: ${report.affectedTests} file(s)`);
    
    console.log('\n============================================================\n');

    if (report.riskLevel === 'critical' || report.riskLevel === 'high') {
      logger.warn('This change has a high impact on the system. Proceed with caution and ensure exhaustive testing.');
    } else {
      logger.success('Impact analysis completed.');
    }
  } catch (error: any) {
    if (error instanceof GhkError) throw error;
    throw new GhkError(`Failed to analyze impact: ${error.message}`, ExitCode.GENERIC, { cause: error });
  }
}

function getRiskBadge(level: string): string {
  switch (level) {
    case 'critical': return '\x1b[41m\x1b[37m CRITICAL \x1b[0m';
    case 'high': return '\x1b[45m\x1b[37m HIGH \x1b[0m';
    case 'medium': return '\x1b[43m\x1b[30m MEDIUM \x1b[0m';
    case 'low': return '\x1b[42m\x1b[30m LOW \x1b[0m';
    default: return level;
  }
}
