/* ==========================================================================
   gherkin-ai-cli - Proposal renderer for `ghk reverse` (PLAN-3.3.0 R-03, R-04)

   One feature per aggregate. The model the generator will read is declared
   with the tags the semantic IR already understands (@aggregate, @command
   per scenario), so mapping candidates to the IR needs no new code path:
   the rendered text is parsed back with the same parser and IR builder
   `lint` uses, and the proposal is only kept when the IR recovers every
   declared command (lossless round trip).
   Every scenario and step is preceded by `# evidence:` comments (ids plus
   file:line), and the feature is tagged @reverse-engineered
   @characterization @needs-review. Output is deterministic: no dates, no
   random ids, stable order.
   ========================================================================== */

import { parseGherkinText } from '../gherkin-parser';
import { buildIR } from '../ir-builder';
import { lintSpecification } from '../specification-linter';
import type { BehaviorCandidate, ProposedStep } from './candidates';
import { atLeast, type EvidenceConfidence, type SourceEvidence } from './evidence';
import { toKebab } from '../../utils/naming';

export interface RenderOptions {
  /** Scenarios below this confidence are left out (default: inferred, i.e. everything but unknown). */
  minConfidence?: EvidenceConfidence;
  /** Lint threshold the proposal is measured against (default 80). */
  threshold?: number;
}

export interface RenderedProposal {
  aggregate: string;
  /** Relative path inside .ghe/reverse/proposals/. */
  file: string;
  text: string;
  commands: string[];
  queries: string[];
  scenarios: number;
  /** Scenarios dropped by --min-confidence. */
  dropped: number;
  lint: { score: number; passed: boolean; diagnostics: { ruleId: string; severity: string; message: string }[] };
  roundTrip: { ok: boolean; missingCommands: string[] };
  confidence: EvidenceConfidence;
}

/** File names follow the generator's own naming (`YRenderizado` → `y-renderizado`). */
export const kebab = (s: string) => toKebab(s);

const evidenceComment = (ids: string[], byId: Map<string, SourceEvidence>, indent: string) => {
  const parts = [...new Set(ids)].sort().map(id => {
    const e = byId.get(id);
    return e ? `${id} ${e.location.file}:${e.location.startLine}` : id;
  });
  return parts.length ? [`${indent}# evidence: ${parts.join(', ')}`] : [];
};

/** `| a | b |` rows with the columns aligned; pipes and backslashes in cells escaped as Gherkin requires. */
function tableLines(rows: string[][], indent: string): string[] {
  const esc = (c: string) => c.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => esc(r[i] ?? '').length)));
  return rows.map(r => `${indent}| ${r.map((c, i) => esc(c ?? '').padEnd(widths[i])).join(' | ')} |`);
}

function renderStep(step: ProposedStep, byId: Map<string, SourceEvidence>): string[] {
  return [...evidenceComment(step.evidence, byId, '    '), `    ${step.keyword} ${step.text}`, ...(step.table?.length ? tableLines(step.table, '      ') : [])];
}

export function renderAggregate(aggregate: string, candidates: BehaviorCandidate[], evidence: SourceEvidence[], options: RenderOptions = {}): RenderedProposal {
  const min = options.minConfidence ?? 'inferred';
  const byId = new Map(evidence.map(e => [e.id, e]));
  const ordered = [...candidates].sort((a, b) => a.operation.path.localeCompare(b.operation.path) || a.operation.method.localeCompare(b.operation.method));
  const commands = [...new Set(ordered.filter(c => c.operation.type === 'command').map(c => c.operation.name))];
  const queries = [...new Set(ordered.filter(c => c.operation.type === 'query').map(c => c.operation.name))];
  const lines: string[] = [
    '# Proposed by `ghk reverse` (beta) from the source code.',
    '# Characterization: it describes what the system does today, not what it should do.',
    '# Review every scenario, then run `ghk reverse accept` to move it into the specifications.',
    '@reverse-engineered @characterization @needs-review',
    `@aggregate:${aggregate}`,
    `Feature: ${aggregate}`,
    `  Operations found in the code: ${ordered.map(c => `${c.operation.method} ${c.operation.path}`).join(', ')}.`,
    ''
  ];
  let scenarios = 0;
  let dropped = 0;
  const kept: EvidenceConfidence[] = [];
  for (const c of ordered) {
    for (const sc of c.scenarios) {
      if (!atLeast(sc.confidence, min)) { dropped++; continue; }
      scenarios++;
      kept.push(sc.confidence);
      lines.push(...evidenceComment(c.endpointEvidence, byId, '  '));
      const tags = [c.operation.type === 'command' ? `@command:${c.operation.name}` : `@query:${c.operation.name}`, `@confidence:${sc.confidence}`];
      lines.push(`  ${tags.join(' ')}`, `  ${sc.examples ? 'Scenario Outline' : 'Scenario'}: ${sc.name}`);
      for (const step of sc.steps) lines.push(...renderStep(step, byId));
      if (sc.examples) {
        // One evidence comment per row: every case of the outline points to the code that rejects it.
        const table = tableLines([sc.examples.header, ...sc.examples.rows.map(r => r.cells)], '      ');
        lines.push('', '    Examples:', table[0]);
        sc.examples.rows.forEach((r, i) => lines.push(...evidenceComment(r.evidence, byId, '      '), table[i + 1]));
      }
      lines.push('');
    }
  }
  const text = lines.join('\n').replace(/\n+$/, '\n');
  const file = `${kebab(aggregate)}.feature`;

  const parsed = parseGherkinText(text);
  const ir = buildIR(parsed, file, { mode: 'deterministic' });
  const irCommands = new Set(ir.commands.map(cmd => cmd.name.replace(/_/g, '').toLowerCase()));
  const declared = [...new Set(ordered.filter(c => c.operation.type === 'command' && c.scenarios.some(s => atLeast(s.confidence, min))).map(c => c.operation.name))];
  const missingCommands = declared.filter(n => !irCommands.has(n.toLowerCase()));
  const threshold = options.threshold ?? 80;
  const lint = lintSpecification(parsed, file, { threshold });
  const confidence = kept.reduce<EvidenceConfidence>((worst, c) => (atLeast(worst, c) ? c : worst), 'confirmed');

  return {
    aggregate, file, text, commands, queries, scenarios, dropped,
    lint: { score: lint.score, passed: lint.passed, diagnostics: lint.diagnostics.map(d => ({ ruleId: d.ruleId, severity: d.severity, message: d.message })) },
    roundTrip: { ok: missingCommands.length === 0, missingCommands },
    confidence: kept.length ? confidence : 'unknown'
  };
}

export function renderProposals(candidates: BehaviorCandidate[], evidence: SourceEvidence[], options: RenderOptions = {}): RenderedProposal[] {
  const byAggregate = new Map<string, BehaviorCandidate[]>();
  for (const c of candidates) byAggregate.set(c.aggregate, [...(byAggregate.get(c.aggregate) ?? []), c]);
  return [...byAggregate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agg, list]) => renderAggregate(agg, list, evidence, options))
    .filter(p => p.scenarios > 0);
}
