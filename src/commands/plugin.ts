/* ==========================================================================
   gherkin-ai-cli - 'plugin' command (PLAN-3.3.0-reverse-plus EC-03)

   ghk plugin list                         the project's plugins: origin, API, extension points, allowed
   ghk plugin new <analyzer|lint-rule|gateway> <name> [--dir d]
                                           a working plugin from a template (passes verify as generated)
   ghk plugin verify <dir> [--run-tools]   the conformance kit; exit 4 when a check fails
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { ExitCode, UsageError } from '../core/errors';
import { emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface PluginCommandOptions {
  dir?: string;
  runTools?: boolean;
  force?: boolean;
  json?: boolean;
}

const SUBCOMMANDS = ['list', 'new', 'verify', 'lock'];

export async function handlePluginCommand(subcommand: string | undefined, args: string[], options: PluginCommandOptions): Promise<void> {
  if (!subcommand || !SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(subcommand ? `Unknown plugin subcommand: ${subcommand}` : 'Missing plugin subcommand.', { hint: `Use one of: ${SUBCOMMANDS.join(', ')}.` });
  }
  const root = process.cwd();

  if (subcommand === 'list') {
    const { projectConfig } = await import('../core/plugins/load');
    const { pluginRegistry } = await import('../core/plugin-system');
    const config = projectConfig(root);
    if (config?.plugins?.load?.length) pluginRegistry.loadFromConfig(config, root);
    const allow = config?.plugins?.allow;
    const rows = pluginRegistry.getPlugins().filter(p => pluginRegistry.originOf(p.name)).map(p => ({
      name: p.name,
      version: p.version,
      apiVersion: p.apiVersion ?? 1,
      engines: p.engines?.['gherkin-ai'],
      from: pluginRegistry.originOf(p.name)!.specifier,
      allowed: allow ? allow.includes(pluginRegistry.originOf(p.name)!.specifier) : 'no allow-list',
      analyzers: (p.reverseAnalyzers?.() ?? []).map(a => `${a.id} (${a.maturity})`),
      lintRules: (p.lintRules?.() ?? []).map(r => r.id),
      gateways: (p.gatewayProviders?.() ?? []).map(g => `${g.id} (${g.maturity})`),
      generates: Boolean(p.generate)
    }));
    if (options.json) { emitJson({ plugins: rows, allow: allow ?? null }); return; }
    if (!rows.length) { logger.info('No plugin is loaded (plugins.load in gherkin-ai.config.json).'); return; }
    for (const r of rows) {
      logger.info(`${r.name} ${r.version}  API ${r.apiVersion}${r.engines ? `, gherkin-ai ${r.engines}` : ''}  from ${r.from}`);
      if (r.analyzers.length) console.log(`  reverse analyzers: ${r.analyzers.join(', ')}`);
      if (r.lintRules.length) console.log(`  lint rules: ${r.lintRules.join(', ')}`);
      if (r.gateways.length) console.log(`  gateway providers: ${r.gateways.join(', ')}`);
      if (r.generates) console.log('  generates artifacts (ghk generate)');
    }
    if (!allow) console.log('  No plugins.allow: any plugin listed in plugins.load is loaded. Organizations should set and lock it.');
    return;
  }

  if (subcommand === 'new') {
    const [kind, name] = args;
    if (!kind || !['analyzer', 'lint-rule', 'gateway'].includes(kind) || !name) {
      throw new UsageError('Usage: ghk plugin new <analyzer|lint-rule|gateway> <name>', { hint: 'ghk plugin new analyzer gherkin-ai-reverse-laravel' });
    }
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*$/.test(name)) throw new UsageError(`Invalid package name: ${name}`, { hint: 'Lower case, digits and dashes; optionally @scope/name.' });
    const { pluginTemplate } = await import('../core/plugins/templates');
    const target = path.resolve(root, options.dir ?? name.replace(/^@[^/]+\//, ''));
    if (fs.existsSync(target) && fs.readdirSync(target).length && !options.force) throw new UsageError(`${path.relative(root, target) || '.'} is not empty.`, { hint: 'Choose another --dir, or pass --force.' });
    const files = pluginTemplate(kind as 'analyzer' | 'lint-rule' | 'gateway', name);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
      fs.writeFileSync(path.join(target, rel), content);
    }
    const created = Object.keys(files).sort().map(f => path.relative(root, path.join(target, f)).split(path.sep).join('/'));
    if (options.json) { emitJson({ created }); return; }
    logger.info(`Plugin ${name} (${kind}) created in ${path.relative(root, target) || '.'}`);
    for (const f of created) console.log(`  + ${f}`);
    console.log(`  Next: ghk plugin verify ${path.relative(root, target) || '.'}`);
    return;
  }

  if (subcommand === 'lock') {
    const { writePluginLock } = await import('../core/plugins/integrity');
    const { projectConfig } = await import('../core/plugins/load');
    const lock = writePluginLock(root, projectConfig(root)?.plugins?.load ?? []);
    if (options.json) { emitJson(lock); return; }
    logger.info(`.ghk/plugins.lock: ${Object.keys(lock.plugins).length} plugin(s) pinned`);
    for (const [spec, entry] of Object.entries(lock.plugins)) console.log(`  ${spec}  ${entry.integrity}`);
    return;
  }

  // verify
  const dir = args[0];
  if (!dir) throw new UsageError('Name the plugin directory to verify.', { hint: 'ghk plugin verify ./my-plugin' });
  if (!fs.existsSync(path.resolve(root, dir))) throw new UsageError(`Not found: ${dir}`);
  const { verifyPlugin } = await import('../core/plugins/verify');
  const report = await verifyPlugin(path.resolve(root, dir), { runTools: options.runTools });
  if (!report.passed) process.exitCode = ExitCode.GATE_FAILED;
  if (options.json) { emitJson(report); return; }
  logger.info(`${report.plugin.name} ${report.plugin.version} (plugin API ${report.plugin.apiVersion})`);
  const show = (checks: { id: string; passed: boolean; detail?: string }[], indent: string) => {
    for (const c of checks) console.log(`${indent}${c.passed ? '✔' : '✖'} ${c.id}${c.detail && !c.passed ? `: ${c.detail}` : c.detail && c.passed && /F1|fixture/.test(c.detail) ? `: ${c.detail}` : ''}`);
  };
  show(report.checks, '  ');
  for (const a of report.analyzers) {
    console.log(`  analyzer ${a.id}: declares ${a.declared}, earns ${a.eligible}`);
    for (const f of a.fixtures) console.log(`    ${f.fixture}: ${f.matched}/${f.expected} endpoints, P ${f.precision.toFixed(2)} R ${f.recall.toFixed(2)} F1 ${f.f1.toFixed(2)}${f.missing.length ? `; missing ${f.missing.join(', ')}` : ''}${f.unexpected.length ? `; unexpected ${f.unexpected.join(', ')}` : ''}`);
    show(a.checks, '    ');
  }
  for (const r of report.lintRules) { console.log(`  lint rule ${r.id}`); show(r.checks, '    '); }
  for (const g of report.gateways) { console.log(`  gateway ${g.id}`); show(g.checks, '    '); }
  console.log(report.passed ? '  All checks pass.' : '  Some checks fail: exit 4.');
}
