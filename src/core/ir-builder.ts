/* ==========================================================================
   gherkin-ai-cli - IR Builder (Gherkin AST → Semantic Intermediate Representation)
   
   Compiles ParsedFeature into a rich SpecificationIR using deterministic
   analysis with optional LLM enrichment for brownfield projects.
   This file assembles the IR and caches it; the extractors are in ./ir/
   (patterns, extract-domain, extract-rules, scenarios, traceability).
   ========================================================================== */

import { ParsedFeature } from './parsers/specification-interface';
import { SpecificationIR, IRBuildOptions, Policy } from './semantic-ir';
import { loadConstitution } from './constitution';
import { resolveDomainProfile } from './profiles/profile-registry';
import { resolveIndustry } from './profiles/industries';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CLI_VERSION } from '../version';
import { parseGherkinText } from './gherkin-parser';
import { generateId, resetIdCounter } from './ir/patterns';
import {
  extractActors,
  extractCommands,
  extractQueries,
  extractEvents,
  extractStateMachines,
  extractInvariants,
  extractAPIEndpoints
} from './ir/extract-domain';
import { extractConstraints, extractPolicies, inferFieldType, extractValidationRules, enrichFields } from './ir/extract-rules';
import {
  enrichScenarios,
  detectMissingScenarioCategories,
  detectAmbiguities,
  detectContradictions,
  calculateScenarioCompleteness,
  calculateConstraintCoverage
} from './ir/scenarios';
import { buildTraceabilityMap, extractAssumptions, extractRisks } from './ir/traceability';

export { categorizeScenarioLabels, coveredCategories } from './ir/scenarios';

// ---------------------------------------------------------------------------
// IR Builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// IR cache (4.8): the IR is a pure function of the feature, the file name, the options and the CLI version, so a
// generate run that rebuilds it for every preset, the linter and the domain model reuses one build. Builds that
// read state outside the key (constitution, existing code base, LLM) are never cached. Callers get a copy.
// ---------------------------------------------------------------------------

const IR_MEMORY_LIMIT = 64;
const irMemory = new Map<string, SpecificationIR>();

function cacheable(options: IRBuildOptions): boolean {
  return !options.constitutionPath && !options.existingCodebase && !options.llmEnrichment && (options.mode ?? 'deterministic') === 'deterministic';
}

/** Cache key of a build: CLI version, file name, options and the parsed feature (or its text). */
export function irCacheKey(input: ParsedFeature | string, sourceFile: string, options: IRBuildOptions): string {
  return crypto.createHash('sha256')
    .update(`${CLI_VERSION}\0${sourceFile}\0${JSON.stringify(options)}\0${typeof input === 'string' ? input : JSON.stringify(input)}`)
    .digest('hex');
}

export function buildIR(
  parsed: ParsedFeature,
  sourceFile: string = 'unknown.feature',
  options: IRBuildOptions = { mode: 'deterministic' }
): SpecificationIR {
  if (!cacheable(options)) return buildIRUncached(parsed, sourceFile, options);
  const key = irCacheKey(parsed, sourceFile, options);
  let ir = irMemory.get(key);
  if (ir) {
    irMemory.delete(key); // least recently used goes first
  } else {
    ir = buildIRUncached(parsed, sourceFile, options);
    if (irMemory.size >= IR_MEMORY_LIMIT) irMemory.delete(irMemory.keys().next().value as string);
  }
  irMemory.set(key, ir);
  // structuredClone drops the non-enumerable source feature: attach the caller's (same content as the key).
  return withSourceFeature(structuredClone(ir), () => parsed);
}

/**
 * IR of a .feature file, cached on disk across runs under <cacheDir>/<sha256>.json (default .ghe/cache/ir), keyed by
 * the file's text, its name, the options and the CLI version. A corrupt or unwritable cache is ignored.
 */
export function buildIRFromFile(file: string, sourceFile: string, options: IRBuildOptions = { mode: 'deterministic' },
  cacheDir = path.join(process.cwd(), '.ghe', 'cache', 'ir')): SpecificationIR {
  const text = fs.readFileSync(file, 'utf8');
  if (!cacheable(options)) return buildIRUncached(parseGherkinText(text), sourceFile, options);
  const cached = path.join(cacheDir, `${irCacheKey(text, sourceFile, options)}.json`);
  try {
    if (fs.existsSync(cached)) {
      let parsed: ParsedFeature | undefined;
      return withSourceFeature(JSON.parse(fs.readFileSync(cached, 'utf8')) as SpecificationIR, () => (parsed ??= parseGherkinText(text)));
    }
  } catch {
    // Corrupt entry: rebuild below.
  }
  const ir = buildIR(parseGherkinText(text), sourceFile, options);
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      // The cache is never versioned, whatever the project's .gitignore says (or if it has none).
      fs.writeFileSync(path.join(cacheDir, '.gitignore'), '*\n');
    }
    const tmp = `${cached}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ir));
    fs.renameSync(tmp, cached);
  } catch {
    // Read-only workspace: the cache is an optimization only.
  }
  return ir;
}

/** Drops the in-memory cache (tests). */
export function clearIRCache(): void {
  irMemory.clear();
}

function buildIRUncached(
  parsed: ParsedFeature,
  sourceFile: string,
  options: IRBuildOptions
): SpecificationIR {
  resetIdCounter();

  const constitution = options.constitutionPath
    ? loadConstitution()
    : null;

  const actors = extractActors(parsed, sourceFile);
  const commands = extractCommands(parsed, sourceFile, actors);
  const queries = extractQueries(parsed, sourceFile);
  const events = extractEvents(parsed, sourceFile, commands);
  const fields = enrichFields(parsed.domainAnalysis.fields.map(f => ({
    name: f.name,
    type: inferFieldType(f.type, f.name),
    required: true,
    validations: extractValidationRules(f.validations),
    exampleValues: [],
    enumValues: undefined,
    ...(f.source ? { source: f.source } : {}),
  })));

  const stateMachines = extractStateMachines(parsed, sourceFile);
  const invariants = extractInvariants(parsed, sourceFile, stateMachines);
  const apiEndpoints = extractAPIEndpoints(parsed, sourceFile, fields);
  const constraints = extractConstraints(parsed, constitution, sourceFile);
  const policies = extractPolicies(parsed, constitution, sourceFile);
  const assumptions = extractAssumptions(parsed, sourceFile);
  const risks = extractRisks(parsed, sourceFile);

  // Automatic Domain Profile Enrichment (Option 2)
  const activeProfileName = options.profileName || options.domainProfile;
  const profile = resolveDomainProfile(activeProfileName);
  if (profile) {
    profile.commonEvents.forEach(pe => {
      if (!events.some(e => e.name.toLowerCase() === pe.name.toLowerCase())) {
        events.push({
          id: generateId('EVT'),
          name: pe.name,
          eventType: pe.name,
          payload: [],
          triggeredBy: commands.length > 0 ? [commands[0].id] : [],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'deterministic'
        });
      }
    });

    profile.commonCommands.forEach(pc => {
      if (!commands.some(c => c.name.toLowerCase() === pc.name.toLowerCase())) {
        commands.push({
          id: generateId('CMD'),
          name: pc.name,
          verb: pc.name.replace(/Payment$/, '').toLowerCase(),
          subject: 'payment',
          inputFields: [],
          preconditions: [],
          postconditions: [],
          triggeredBy: actors[0]?.id || 'ACT-0001',
          emittedEvents: [],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'deterministic'
        });
      }
    });

    if (profile.stateMachines) {
      for (const [smName, states] of Object.entries(profile.stateMachines)) {
        if (!stateMachines.some(sm => sm.entity === smName)) {
          stateMachines.push({
            entity: smName,
            states: states.map(s => s.name),
            initialState: states[0]?.name || 'Pending',
            finalStates: states.filter(s => s.transitions.length === 0).map(s => s.name),
            transitions: states.flatMap(s => s.transitions.map(t => ({
              id: generateId('TRN'),
              entity: smName,
              fromState: s.name,
              toState: t,
              trigger: `On${t}`,
              guards: [],
              source: { file: sourceFile, line: 0 },
              confidence: 1.0,
              inferenceSource: 'deterministic'
            })))
          });
        }
      }
    }

    profile.getStandardRules().forEach(rule => {
      constraints.push({
        id: generateId('CST'),
        level: 'must',
        description: `Profile Requirement: ${rule}`,
        category: 'compliance',
        evidence: [profile.id],
        source: { file: sourceFile, line: 0 },
        confidence: 1.0,
        inferenceSource: 'deterministic'
      });
    });

    policies.push({
      id: generateId('POL'),
      name: `${profile.name} Governance Policy`,
      type: 'security',
      rules: [
        `Domain Profile: ${profile.name} (${profile.id})`,
        `Mandatory Rules: ${profile.getStandardRules().join(', ')}`
      ],
      source: { file: sourceFile, line: 0 },
      confidence: 1.0,
      inferenceSource: 'deterministic'
    });
  }

  // Industry standard (BIAN, FHIR, ...): guidance for the implementation, not extra commands or events.
  const industry = resolveIndustry(options.industry);
  if (industry && industry.id !== 'generic') {
    industry.guidance.rules.forEach(rule => {
      constraints.push({
        id: generateId('CST'),
        level: 'must',
        description: `Industry Requirement (${industry.label}): ${rule}`,
        category: 'compliance',
        evidence: industry.standards.map(s => s.id),
        source: { file: sourceFile, line: 0 },
        confidence: 1.0,
        inferenceSource: 'deterministic'
      });
    });
    policies.push({
      id: generateId('POL'),
      name: `${industry.label} Industry Standards Policy`,
      type: 'compliance',
      rules: [
        `Standards: ${industry.standards.map(s => s.name).join(', ')}`,
        `Canonical model: ${industry.canonicalModel}`,
        ...industry.compliance.map(c => `Compliance reminder (guidance, not certification): ${c}`)
      ],
      source: { file: sourceFile, line: 0 },
      confidence: 1.0,
      inferenceSource: 'deterministic'
    });
  }

  const enrichedScenarios = enrichScenarios(
    parsed.scenarios, sourceFile, actors, commands, queries
  );

  const missingCategories = detectMissingScenarioCategories(enrichedScenarios);
  const ambiguities = detectAmbiguities(parsed);
  const contradictions = detectContradictions(enrichedScenarios, invariants);

  const traceability = buildTraceabilityMap(
    enrichedScenarios, commands, queries, events, invariants, apiEndpoints
  );

  const ir: SpecificationIR = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    sourceFile,

    featureId: generateId('FTR'),
    featureName: parsed.featureName,
    featureDescription: parsed.descriptionLines,
    tags: parsed.tags,

    actors,
    commands,
    queries,
    events,
    fields,

    scenarios: enrichedScenarios,
    stateMachines,
    invariants,

    apiEndpoints,

    constraints,
    policies,
    assumptions,
    risks,

    traceability,

    qualityIndicators: {
      scenarioCompleteness: calculateScenarioCompleteness(enrichedScenarios, missingCategories),
      constraintCoverage: calculateConstraintCoverage(constraints, enrichedScenarios),
      missingScenarioCategories: missingCategories,
      ambiguities,
      contradictions,
    },
  };
  return withSourceFeature(ir, () => parsed);
}

// Generators need the verbatim steps (the IR classifies them and may drop "And" steps).
// Non-enumerable so it never appears in serialized IR.
function withSourceFeature(ir: SpecificationIR, source: () => ParsedFeature): SpecificationIR {
  return Object.defineProperty(ir, 'sourceFeature', { get: source, enumerable: false });
}

/** The parsed feature an IR was built from, when available. */
export function getSourceFeature(ir: SpecificationIR): ParsedFeature | undefined {
  return (ir as SpecificationIR & { sourceFeature?: ParsedFeature }).sourceFeature;
}

export const buildSpecificationIR = buildIR;

