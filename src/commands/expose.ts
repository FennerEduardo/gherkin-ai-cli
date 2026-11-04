/* ==========================================================================
   gherkin-ai-cli - 'expose' command: the service's business capabilities as
   MCP tools for agents (PLAN-3.3.0-reverse-plus §3.F)

   ghk expose discover [--contract f] [--from-reverse] [--json]
       proposes the capability manifest in .ghe/expose/ (never approves)

   `ghk mcp` stays the development MCP server (features, lint, reverse);
   `ghk expose` builds the one that serves the business to agents.
   ========================================================================== */

import { UsageError } from '../core/errors';
import { emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface ExposeCommandOptions {
  contract?: string;
  fromReverse?: boolean;
  json?: boolean;
  dryRun?: boolean;
}

const SUBCOMMANDS = ['discover'];

export async function handleExposeCommand(subcommand: string | undefined, args: string[], options: ExposeCommandOptions): Promise<void> {
  if (!subcommand || !SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(subcommand ? `Unknown expose subcommand: ${subcommand}` : 'Missing expose subcommand.', { hint: `Use one of: ${SUBCOMMANDS.join(', ')}.` });
  }
  const root = process.cwd();

  if (subcommand === 'discover') {
    const { discoverCapabilities } = await import('../core/expose/discover');
    let result;
    try {
      result = discoverCapabilities(root, { contract: options.contract, fromReverse: options.fromReverse, write: !options.dryRun });
    } catch (err) {
      if (/^Contract not found/.test((err as Error).message)) throw new UsageError((err as Error).message, { hint: 'Pass the OpenAPI document of the service with --contract <file>.' });
      throw err;
    }
    if (options.json) {
      emitJson({ ...result, manifest: undefined, capabilities: result.manifest.capabilities.map(c => ({ id: c.id, name: c.name, effect: c.effect, status: c.status, approval: c.execution.approval, handler: c.handler ? `${c.handler.method} ${c.handler.path}` : null, features: c.source.features, reason: c.reason })) });
      return;
    }
    logger.info(`ghk expose discover: ${result.manifest.capabilities.length} capabilities from ${result.features} feature(s)${result.contract ? ` and ${result.contract}` : ''}`);
    for (const c of result.manifest.capabilities) {
      const where = c.handler ? `${c.handler.method} ${c.handler.path}` : 'no handler';
      console.log(`  ${c.status.padEnd(21)} ${c.effect.padEnd(18)} ${c.name}  (${where})${c.execution.approval === 'human' ? '  human approval per call' : ''}`);
      if (c.reason) console.log(`      ${c.reason}`);
    }
    for (const ch of result.changes.filter(x => x.change !== 'unchanged')) console.log(`  ${ch.change} against .ghk/capabilities.yaml: ${ch.id}`);
    for (const w of result.warnings) logger.warn(w);
    if (result.proposal) console.log(`\n  Proposal: ${result.proposal}. Nothing is approved: review it, then \`ghk expose approve <id>\`.`);
    else console.log('\n  --dry-run: nothing written.');
  }
}
