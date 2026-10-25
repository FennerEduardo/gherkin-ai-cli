/* ==========================================================================
   gherkin-ai-cli - Contract drift: hard checks next to the convergence score

   The convergence dimensions measure how well the artifacts line up; a
   service can score well and still serve another route, or a feature can
   name a state its contracts do not have (LMS evidence report E-11: a route
   renamed in the controller and a state renamed in the feature both scored
   62, like the untouched service). These checks pass or fail:

   - spec-changed: the feature was edited after its contracts were
     generated, and the contracts were not (inventory checksums). Gates.
   - live-contract: the operations of the contracts on disk (openapi.json,
     contracts/<feature>/openapi.json) against the OpenAPI document the
     running service serves (`ghk converge --live <file|url>`). Gates.
   - spec-states: every state the feature spells out (`status "DRAFT"`) is a
     value of an enum in the contracts. Reported; gates with
     --strict-contracts (a state can belong to another service's entity).
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { InventoryFile } from './inventory';
import { matchesChecksum, sha256 } from './write-protection';

export interface ContractCheck {
  check: 'spec-changed' | 'live-contract' | 'spec-states';
  passed: boolean;
  /** Whether a failure fails `ghk converge` (exit 7). */
  gating: boolean;
  findings: string[];
}

/**
 * The feature changed since it was generated from, and none of its contracts did: the contracts (and the code
 * generated with them) describe the previous feature. Not applicable without a record of that run (generated
 * before 3.2.1), or when a contract changed too (that edit may be the matching change).
 */
export function specChangedCheck(projectDir: string, featureFile: string, featureText: string, inventory: InventoryFile, outputDir = './'): ContractCheck | undefined {
  const rel = path.relative(projectDir, path.resolve(projectDir, featureFile)).replace(/\\/g, '/');
  const recorded = inventory.features?.[rel];
  if (!recorded || typeof recorded !== 'object') return undefined;
  if (recorded.checksum === sha256(featureText.replace(/\r\n/g, '\n'))) return { check: 'spec-changed', passed: true, gating: true, findings: [] };
  const contracts = Object.entries(recorded.contracts ?? {});
  const untouched = contracts.filter(([file, checksum]) => {
    const full = path.resolve(projectDir, outputDir, file);
    return fs.existsSync(full) && matchesChecksum(fs.readFileSync(full), checksum);
  });
  if (!contracts.length || untouched.length !== contracts.length) return undefined;
  return {
    check: 'spec-changed',
    passed: false,
    gating: true,
    findings: [`${rel} changed after it was generated, but its contracts did not (${untouched.map(([f]) => f).slice(0, 3).join(', ')}${untouched.length > 3 ? ', ...' : ''}): regenerate with \`ghk generate -f ${rel}\` and update the code, or revert the feature.`]
  };
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

export function parseApiDocument(text: string): any {
  const trimmed = text.trim();
  return trimmed.startsWith('{') ? JSON.parse(trimmed) : YAML.parse(trimmed);
}

/** "POST /api/v1/orders/{}" for every operation of an OpenAPI document (parameter names do not matter). */
export function openApiOperations(doc: any): Set<string> {
  const ops = new Set<string>();
  for (const [route, item] of Object.entries<any>(doc?.paths ?? {})) {
    const normalized = route.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
    for (const method of METHODS) if (item && typeof item === 'object' && item[method]) ops.add(`${method.toUpperCase()} ${normalized}`);
  }
  return ops;
}

/**
 * The OpenAPI and AsyncAPI documents of a project: root files and contracts/<feature>/ ones. `serviceOpenapi`
 * is the service's own contract: the root openapi.* (the merge of every feature), else the per-feature ones.
 */
export function readContractDocuments(projectDir: string, outputDir = './'): { openapi: any[]; asyncapi: any[]; serviceOpenapi: any[] } {
  const root = path.resolve(projectDir, outputDir);
  const docs = { openapi: [] as any[], asyncapi: [] as any[] };
  const read = (file: string, kind: 'openapi' | 'asyncapi') => {
    try { docs[kind].push(parseApiDocument(fs.readFileSync(file, 'utf8'))); } catch { /* reported by validate */ }
  };
  for (const kind of ['openapi', 'asyncapi'] as const) {
    for (const ext of ['json', 'yaml', 'yml']) {
      const file = path.join(root, `${kind}.${ext}`);
      if (fs.existsSync(file)) read(file, kind);
    }
  }
  const rootOpenapi = [...docs.openapi];
  const contractsDir = path.join(root, 'contracts');
  if (fs.existsSync(contractsDir)) {
    for (const entry of fs.readdirSync(contractsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const kind of ['openapi', 'asyncapi'] as const) {
        const file = path.join(contractsDir, entry.name, `${kind}.json`);
        if (fs.existsSync(file)) read(file, kind);
      }
    }
  }
  return { ...docs, serviceOpenapi: rootOpenapi.length ? rootOpenapi : docs.openapi };
}

/** Operations the contracts declare that the running service does not serve (and the reverse, reported only). */
export function liveContractCheck(contracts: any[], live: any): ContractCheck & { undocumented: string[] } {
  const declared = new Set(contracts.flatMap(doc => [...openApiOperations(doc)]));
  const served = openApiOperations(live);
  const missing = [...declared].filter(op => !served.has(op)).sort();
  const undocumented = [...served].filter(op => !declared.has(op)).sort();
  return {
    check: 'live-contract',
    passed: declared.size > 0 && missing.length === 0,
    gating: true,
    findings: declared.size === 0
      ? ['No operations in the contracts on disk to compare with the live document.']
      : missing.map(op => `${op} is in the contract but the service does not serve it`),
    undocumented
  };
}

/** Every string listed in an `enum` anywhere in the documents. */
function enumValues(docs: any[]): Set<string> {
  const values = new Set<string>();
  const walk = (node: any) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum)) for (const v of node.enum) if (typeof v === 'string') values.add(v);
    for (const value of Object.values(node)) walk(value);
  };
  docs.forEach(walk);
  return values;
}

/**
 * States a feature spells out: an upper-case quoted value right after "status" / "state" / "estado"
 * (`has status "DRAFT"`, `status should become "PUBLISHED"`). Inferred states (from verbs such as
 * "is published") are not used: they are not something the contracts must list.
 */
export function statesNamedInSteps(stepTexts: string[]): string[] {
  const states = new Set<string>();
  const re = /\b(?:status|state|estado)\b(?:\s+(?:should|must|is|are|was|becomes?|be|to|of|changes?|debe|es|pasa|cambia|ser|a|al))*\s+"([A-Z][A-Z0-9_]*)"/gi;
  for (const text of stepTexts) {
    for (const m of text.matchAll(re)) if (m[1] === m[1].toUpperCase()) states.add(m[1]);
  }
  return [...states];
}

/** States the feature names that no enum of the contracts has. Not applicable when the contracts declare no enums. */
export function specStatesCheck(stepTexts: string[], docs: { openapi: any[]; asyncapi: any[] }, strict = false): ContractCheck | undefined {
  const values = enumValues([...docs.openapi, ...docs.asyncapi]);
  const states = statesNamedInSteps(stepTexts);
  if (values.size === 0 || states.length === 0) return undefined;
  const findings = states.filter(s => !values.has(s)).map(s => `State "${s}" is in the feature but in no enum of the contracts`);
  return { check: 'spec-states', passed: findings.length === 0, gating: strict, findings };
}

export interface ContractCheckOptions {
  /** OpenAPI document the running service serves (`--live`). */
  live?: any;
  /** spec-states failures fail too. */
  strict?: boolean;
}

/** Every contract check that applies to one feature of the project in `projectDir`. */
export function contractChecks(projectDir: string, featureFile: string, featureText: string, stepTexts: string[], inventory: InventoryFile, outputDir = './', options: ContractCheckOptions = {}): ContractCheck[] {
  const docs = readContractDocuments(projectDir, outputDir);
  return [
    specChangedCheck(projectDir, featureFile, featureText, inventory, outputDir),
    options.live !== undefined ? liveContractCheck(docs.serviceOpenapi, options.live) : undefined,
    specStatesCheck(stepTexts, docs, options.strict)
  ].filter((c): c is ContractCheck => c !== undefined);
}
