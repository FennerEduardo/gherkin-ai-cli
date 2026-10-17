/* ==========================================================================
   gherkin-ai-cli - 'industry' Command Handler

   ghk industry list            industries and their reference standards
   ghk industry show <id>       rules, glossary, lint rules and sources
   ghk industry apply <id>      set industry.id in ./gherkin-ai.config.json
                                and write .ghe/industry-context.{md,json}
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { emitJson } from '../utils/output';
import { ConfigError, UsageError } from '../core/errors';
import { partialConfigSchema } from '../core/config';
import {
  INDUSTRIES, INDUSTRY_IDS, CAPABILITY_DEPTH_RULE, resolveIndustry,
  renderIndustryContextJson, renderIndustryContextMarkdown, IndustryProfile
} from '../core/profiles/industries';
import { INDUSTRY_CONTEXT_MD, writeIndustryContext } from '../core/profiles/industries/context-files';

export interface IndustryCommandOptions {
  json?: boolean;
}

function requireIndustry(id: string | undefined): IndustryProfile {
  const profile = resolveIndustry(id);
  if (!profile) throw new UsageError(`Unknown industry "${id ?? ''}". Available: ${INDUSTRY_IDS.join(', ')}.`);
  return profile;
}

export async function handleIndustryCommand(subcommand = 'list', id: string | undefined, options: IndustryCommandOptions = {}): Promise<void> {
  if (subcommand === 'list') {
    const rows = INDUSTRY_IDS.map(i => INDUSTRIES[i]).map(p => ({
      id: p.id,
      label: p.label,
      standards: p.standards.map(s => s.id),
      lintRules: [...p.lintRules, CAPABILITY_DEPTH_RULE].map(r => r.id)
    }));
    if (options.json) return emitJson(rows);
    console.log(chalk.bold.cyan('\n🏛️  Industry profiles\n'));
    for (const r of rows) {
      console.log(`  ${chalk.bold(r.id.padEnd(14))} ${r.label}`);
      console.log(chalk.gray(`  ${''.padEnd(14)} standards: ${r.standards.join(', ') || '-'} · lint: ${r.lintRules.join(', ')}`));
    }
    console.log(chalk.gray('\n  ghk industry show <id> for the rules; ghk industry apply <id> to use one in this project.\n'));
    return;
  }

  if (subcommand === 'show') {
    const profile = requireIndustry(id);
    if (options.json) return emitJson(JSON.parse(renderIndustryContextJson(profile)));
    console.log(renderIndustryContextMarkdown(profile));
    return;
  }

  if (subcommand === 'apply') {
    const profile = requireIndustry(id);
    const configPath = path.join(process.cwd(), 'gherkin-ai.config.json');
    if (!fs.existsSync(configPath)) throw new ConfigError(`No gherkin-ai.config.json in ${process.cwd()}. Run ghk init first.`);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const next = { ...raw, industry: { ...(raw.industry || {}), id: profile.id } };
    const parsed = partialConfigSchema.safeParse(next);
    if (!parsed.success) throw new ConfigError(`Invalid configuration after applying the industry: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    writeIndustryContext(process.cwd(), next);

    const result = {
      industry: profile.id,
      configPath,
      context: INDUSTRY_CONTEXT_MD,
      architecture: { current: raw.architecture, recommended: profile.recommendedArchitectures },
      recommendedPatterns: profile.recommendedPatterns,
      lintRules: [...profile.lintRules, CAPABILITY_DEPTH_RULE].map(r => r.id)
    };
    if (options.json) return emitJson(result);
    console.log(chalk.green(`\n✔ industry.id = "${profile.id}" (${profile.label}) saved to gherkin-ai.config.json`));
    console.log(chalk.green(`✔ Rules for agents written to ${INDUSTRY_CONTEXT_MD}`));
    if (raw.architecture && !profile.recommendedArchitectures.includes(raw.architecture)) {
      console.log(chalk.yellow(`⚠ Architecture "${raw.architecture}" is not among the recommended ones: ${profile.recommendedArchitectures.join(', ')}.`));
    }
    console.log(chalk.gray(`  Recommended patterns: ${profile.recommendedPatterns.join(', ')}`));
    console.log(chalk.gray(`  ghk lint now also runs: ${result.lintRules.join(', ')}\n`));
    return;
  }

  throw new UsageError(`Unknown subcommand "${subcommand}". Use: list | show <id> | apply <id>.`);
}
