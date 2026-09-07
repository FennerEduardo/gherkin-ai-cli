/* ==========================================================================
   gherkin-ai-cli - Specification Linter Engine
   
   Analyzes Gherkin specifications for quality, completeness, consistency
   and enterprise compliance. Returns actionable diagnostics with severity
   levels and auto-fix suggestions.
   ========================================================================== */

import { ParsedFeature, ScenarioModel, StepModel } from './gherkin-parser';
import { Constitution, loadConstitution } from './constitution';

// ---------------------------------------------------------------------------
// Lint Rule Definitions
// ---------------------------------------------------------------------------

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintDiagnostic {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  scenario?: string;
  step?: string;
  suggestion?: string;
  line?: number;
}

export interface LintResult {
  file: string;
  featureName: string;
  diagnostics: LintDiagnostic[];
  score: number;          // 0-100
  passed: boolean;        // score >= threshold
}

export interface LintOptions {
  threshold?: number;     // default: 70
  constitution?: Constitution | null;
  disabledRules?: string[];
}

// ---------------------------------------------------------------------------
// Lint Rule Registry
// ---------------------------------------------------------------------------

interface LintRule {
  id: string;
  name: string;
  severity: LintSeverity;
  check: (parsed: ParsedFeature, opts: LintOptions) => LintDiagnostic[];
}

const LINT_RULES: LintRule[] = [
  // GHK001: Ambiguous Scenario
  {
    id: 'GHK001',
    name: 'Ambiguous scenario',
    severity: 'warning',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const vaguePhrases = [
        /\b(something|somehow|somewhere|correctly|properly|appropriately)\b/i,
        /\b(algo|algún|de alguna manera|correctamente|apropiadamente)\b/i,
        /\b(the system works|el sistema funciona|it should work|debería funcionar)\b/i,
        /\b(everything|todo)\b/i,
      ];
      for (const sc of parsed.scenarios) {
        for (const step of sc.steps) {
          for (const phrase of vaguePhrases) {
            if (phrase.test(step.text)) {
              diags.push({
                ruleId: 'GHK001',
                severity: 'warning',
                message: `Ambiguous language detected: "${step.text}"`,
                scenario: sc.name,
                step: step.text,
                suggestion: 'Use specific, measurable outcomes instead of vague language.',
              });
            }
          }
        }
      }
      return diags;
    },
  },

  // GHK002: Missing Actor
  {
    id: 'GHK002',
    name: 'Missing actor',
    severity: 'warning',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const actorPatterns = [
        /\b(as a|as an|como un|como una)\b/i,
        /\b(the user|the admin|the customer|the system|el usuario|el administrador|el cliente|el sistema)\b/i,
      ];
      const hasActor = parsed.descriptionLines.some(l =>
        actorPatterns.some(p => p.test(l))
      ) || parsed.scenarios.some(sc =>
        sc.steps.some(s => actorPatterns.some(p => p.test(s.text)))
      );

      if (!hasActor) {
        diags.push({
          ruleId: 'GHK002',
          severity: 'warning',
          message: 'No actor/persona defined in the feature description or scenarios.',
          suggestion: 'Add "As a [role]" in the feature description or Given steps.',
        });
      }
      return diags;
    },
  },

  // GHK003: Missing Expected Outcome
  {
    id: 'GHK003',
    name: 'Missing expected outcome',
    severity: 'error',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      for (const sc of parsed.scenarios) {
        const hasThen = sc.steps.some(s => s.keyword === 'Then');
        if (!hasThen) {
          diags.push({
            ruleId: 'GHK003',
            severity: 'error',
            message: `Scenario "${sc.name}" has no Then (expected outcome) step.`,
            scenario: sc.name,
            suggestion: 'Every scenario must have at least one Then step defining the expected behavior.',
          });
        }
      }
      return diags;
    },
  },

  // GHK004: Duplicated Scenario
  {
    id: 'GHK004',
    name: 'Duplicated scenario',
    severity: 'warning',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const nameCount = new Map<string, number>();
      const stepHashes = new Map<string, string>();

      for (const sc of parsed.scenarios) {
        // Check name duplication
        const normalizedName = sc.name.toLowerCase().trim();
        nameCount.set(normalizedName, (nameCount.get(normalizedName) || 0) + 1);

        // Check step content duplication
        const stepHash = sc.steps.map(s => `${s.keyword}:${s.text.toLowerCase().trim()}`).join('|');
        if (stepHashes.has(stepHash)) {
          diags.push({
            ruleId: 'GHK004',
            severity: 'warning',
            message: `Scenario "${sc.name}" has identical steps to "${stepHashes.get(stepHash)}".`,
            scenario: sc.name,
            suggestion: 'Consider merging duplicate scenarios or using Scenario Outline with Examples.',
          });
        } else {
          stepHashes.set(stepHash, sc.name);
        }
      }

      for (const [name, count] of nameCount) {
        if (count > 1) {
          diags.push({
            ruleId: 'GHK004',
            severity: 'warning',
            message: `Scenario name "${name}" appears ${count} times.`,
            suggestion: 'Use unique, descriptive scenario names.',
          });
        }
      }

      return diags;
    },
  },

  // GHK005: Contradictory Rule
  {
    id: 'GHK005',
    name: 'Contradictory rule',
    severity: 'error',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      // Detect scenarios where Given states contradict Then states
      const statePattern = /(?:status|estado|state)\s*"([^"]+)"/i;

      for (let i = 0; i < parsed.scenarios.length; i++) {
        for (let j = i + 1; j < parsed.scenarios.length; j++) {
          const sc1 = parsed.scenarios[i];
          const sc2 = parsed.scenarios[j];

          // Find state in Given/Then
          const sc1Given = sc1.steps.find(s => s.keyword === 'Given' && statePattern.test(s.text));
          const sc1Then = sc1.steps.find(s => s.keyword === 'Then' && statePattern.test(s.text));
          const sc2Given = sc2.steps.find(s => s.keyword === 'Given' && statePattern.test(s.text));
          const sc2Then = sc2.steps.find(s => s.keyword === 'Then' && statePattern.test(s.text));

          if (sc1Given && sc1Then && sc2Given && sc2Then) {
            const g1 = sc1Given.text.match(statePattern)?.[1];
            const t1 = sc1Then.text.match(statePattern)?.[1];
            const g2 = sc2Given.text.match(statePattern)?.[1];
            const t2 = sc2Then.text.match(statePattern)?.[1];

            // Same Given state but contradictory Then states
            if (g1 === g2 && t1 !== t2) {
              // Check if the When steps are also similar
              const w1 = sc1.steps.filter(s => s.keyword === 'When').map(s => s.text.toLowerCase()).join(' ');
              const w2 = sc2.steps.filter(s => s.keyword === 'When').map(s => s.text.toLowerCase()).join(' ');
              if (w1 === w2) {
                diags.push({
                  ruleId: 'GHK005',
                  severity: 'error',
                  message: `Potential contradiction: "${sc1.name}" and "${sc2.name}" have the same preconditions and actions but different outcomes (${t1} vs ${t2}).`,
                  scenario: sc1.name,
                  suggestion: 'Review business rules to resolve the contradiction.',
                });
              }
            }
          }
        }
      }

      return diags;
    },
  },

  // GHK006: Undefined Business Term
  {
    id: 'GHK006',
    name: 'Undefined business term',
    severity: 'info',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      // Check for technical terms that leak into business specs
      const techTerms = [
        /\b(database|tabla|table|column|columna|index|índice|foreign key|clave foránea)\b/i,
        /\b(sql|nosql|mongodb|redis|kafka|rabbitmq)\b/i,
        /\b(api|endpoint|http|rest|graphql|grpc|websocket)\b/i,
        /\b(repository|controller|service|middleware|handler|decorator)\b/i,
        /\b(json|xml|yaml|csv|protobuf)\b/i,
        /\b(docker|kubernetes|aws|azure|gcp)\b/i,
      ];

      // This rule is now GHK007 but we still detect business term issues
      // Check for undefined acronyms
      for (const sc of parsed.scenarios) {
        for (const step of sc.steps) {
          const acronyms = step.text.match(/\b[A-Z]{2,}\b/g);
          if (acronyms) {
            for (const acr of acronyms) {
              if (!['HTTP', 'API', 'ID', 'UUID', 'URL', 'OK', 'COP', 'USD', 'EUR', 'JWT'].includes(acr)) {
                diags.push({
                  ruleId: 'GHK006',
                  severity: 'info',
                  message: `Acronym "${acr}" used in "${sc.name}" — ensure it's defined in a glossary.`,
                  scenario: sc.name,
                  step: step.text,
                  suggestion: 'Define all domain-specific acronyms in the feature description.',
                });
              }
            }
          }
        }
      }

      return diags;
    },
  },

  // GHK007: Implementation Leakage
  {
    id: 'GHK007',
    name: 'Implementation leakage',
    severity: 'warning',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const techLeaks = [
        { pattern: /\b(database|tabla|table|column)\b/i, term: 'database terminology' },
        { pattern: /\b(sql|nosql|mongodb|redis|kafka)\b/i, term: 'database technology' },
        { pattern: /\b(click|tap|swipe|scroll|hover|div|button|span|css|html)\b/i, term: 'UI implementation detail' },
        { pattern: /\b(repository|controller|service|middleware|handler)\b/i, term: 'code pattern' },
        { pattern: /\b(docker|kubernetes|aws|azure|gcp|lambda)\b/i, term: 'infrastructure' },
        { pattern: /\b(json|xml|protobuf|avro)\b/i, term: 'serialization format' },
        { pattern: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/, term: 'SQL statement' },
      ];

      for (const sc of parsed.scenarios) {
        for (const step of sc.steps) {
          for (const leak of techLeaks) {
            if (leak.pattern.test(step.text)) {
              diags.push({
                ruleId: 'GHK007',
                severity: 'warning',
                message: `Implementation leakage (${leak.term}) in step: "${step.text}"`,
                scenario: sc.name,
                step: step.text,
                suggestion: 'Gherkin should describe behavior, not implementation. Use business language.',
              });
            }
          }
        }
      }

      return diags;
    },
  },

  // GHK008: Excessive Scenario Complexity
  {
    id: 'GHK008',
    name: 'Excessive scenario complexity',
    severity: 'warning',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const MAX_STEPS = 10;
      const MAX_GIVEN = 5;

      for (const sc of parsed.scenarios) {
        if (sc.steps.length > MAX_STEPS) {
          diags.push({
            ruleId: 'GHK008',
            severity: 'warning',
            message: `Scenario "${sc.name}" has ${sc.steps.length} steps (max recommended: ${MAX_STEPS}).`,
            scenario: sc.name,
            suggestion: 'Break complex scenarios into smaller, focused scenarios. Consider Background for shared Given steps.',
          });
        }

        const givenCount = sc.steps.filter(s => s.keyword === 'Given' || (s.keyword === 'And')).length;
        if (givenCount > MAX_GIVEN) {
          diags.push({
            ruleId: 'GHK008',
            severity: 'warning',
            message: `Scenario "${sc.name}" has ${givenCount} preconditions (max recommended: ${MAX_GIVEN}).`,
            scenario: sc.name,
            suggestion: 'Consider using Background for shared setup or simplifying the preconditions.',
          });
        }
      }

      return diags;
    },
  },

  // GHK009: Missing Error Path
  {
    id: 'GHK009',
    name: 'Missing error path',
    severity: 'warning',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const errorPatterns = [
        /\b(error|fail|invalid|denied|forbidden|not found|unauthorized)\b/i,
        /\b(error|fallo|inválido|denegado|prohibido|no encontrado|no autorizado)\b/i,
        /\b(HTTP\s*(4|5)\d{2})\b/i,
        /\b(should not|must not|cannot|no debe|no puede)\b/i,
      ];

      const hasErrorScenario = parsed.scenarios.some(sc =>
        sc.steps.some(s => errorPatterns.some(p => p.test(s.text))) ||
        sc.tags.some(t => /@error|@negative|@sad.?path/i.test(t))
      );

      if (!hasErrorScenario && parsed.scenarios.length > 0) {
        diags.push({
          ruleId: 'GHK009',
          severity: 'warning',
          message: 'No error/negative-path scenarios found in this feature.',
          suggestion: 'Add scenarios for validation failures, authorization errors, not-found cases, etc.',
        });
      }

      return diags;
    },
  },

  // GHK010: Missing Authorization
  {
    id: 'GHK010',
    name: 'Missing authorization',
    severity: 'warning',
    check: (parsed, opts) => {
      const diags: LintDiagnostic[] = [];
      const authPatterns = [
        /\b(authenticated|authorized|logged in|autenticado|autorizado|con sesión)\b/i,
        /\b(permission|permiso|role|rol|admin|token|jwt|session|sesión)\b/i,
      ];

      // Check if write operations exist but no auth mentioned
      const hasWriteOps = parsed.scenarios.some(sc =>
        sc.steps.some(s =>
          s.keyword === 'When' &&
          /\b(create|update|delete|cancel|approve|submit|crea|actualiza|elimina|cancela|aprueba|envía)\b/i.test(s.text)
        )
      );

      const hasAuth = parsed.scenarios.some(sc =>
        sc.steps.some(s => authPatterns.some(p => p.test(s.text)))
      );

      // Check if constitution requires auth
      const constitutionRequiresAuth = opts.constitution?.constraints?.some(
        c => c.category === 'security' && c.level === 'must' && /auth/i.test(c.description)
      );

      if (hasWriteOps && !hasAuth) {
        diags.push({
          ruleId: 'GHK010',
          severity: constitutionRequiresAuth ? 'error' : 'warning',
          message: 'Write operations exist but no authorization scenarios are defined.',
          suggestion: 'Add Given steps for authentication (e.g., "Given the user is authenticated") and scenarios for unauthorized access.',
        });
      }

      return diags;
    },
  },

  // GHK011: Missing Idempotency
  {
    id: 'GHK011',
    name: 'Missing idempotency',
    severity: 'info',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const hasCreateOrMutate = parsed.scenarios.some(sc =>
        sc.steps.some(s =>
          s.keyword === 'When' &&
          /\b(create|submit|send|pay|transfer|crea|envía|paga|transfiere)\b/i.test(s.text)
        )
      );

      const hasIdempotency = parsed.scenarios.some(sc =>
        sc.steps.some(s => /\b(idempoten|duplicate|duplica|twice|dos veces|already exists|ya existe)\b/i.test(s.text)) ||
        sc.tags.some(t => /@idempoten/i.test(t))
      );

      if (hasCreateOrMutate && !hasIdempotency) {
        diags.push({
          ruleId: 'GHK011',
          severity: 'info',
          message: 'Mutation operations found but no idempotency scenarios defined.',
          suggestion: 'Consider adding scenarios for duplicate requests (e.g., "When the same request is sent twice").',
        });
      }

      return diags;
    },
  },

  // GHK012: Missing Observability
  {
    id: 'GHK012',
    name: 'Missing observability',
    severity: 'info',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      const hasObservability = parsed.scenarios.some(sc =>
        sc.steps.some(s =>
          /\b(log|audit|metric|trace|monitor|notification|alert|registro|auditoría|métrica|traza|monitoreo|notificación|alerta)\b/i.test(s.text)
        ) || sc.tags.some(t => /@observ|@audit|@monitor/i.test(t))
      );

      if (!hasObservability && parsed.scenarios.length > 2) {
        diags.push({
          ruleId: 'GHK012',
          severity: 'info',
          message: 'No observability or audit scenarios found.',
          suggestion: 'Consider adding scenarios for audit logging, metrics emission, or notification triggers.',
        });
      }

      return diags;
    },
  },

  // GHK013: Missing When Step
  {
    id: 'GHK013',
    name: 'Missing action step',
    severity: 'error',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      for (const sc of parsed.scenarios) {
        const hasWhen = sc.steps.some(s => s.keyword === 'When');
        if (!hasWhen) {
          diags.push({
            ruleId: 'GHK013',
            severity: 'error',
            message: `Scenario "${sc.name}" has no When (action) step.`,
            scenario: sc.name,
            suggestion: 'Every scenario must have at least one When step defining the action being tested.',
          });
        }
      }
      return diags;
    },
  },

  // GHK014: Empty Feature
  {
    id: 'GHK014',
    name: 'Empty feature',
    severity: 'error',
    check: (parsed) => {
      const diags: LintDiagnostic[] = [];
      if (parsed.scenarios.length === 0) {
        diags.push({
          ruleId: 'GHK014',
          severity: 'error',
          message: 'Feature has no scenarios defined.',
          suggestion: 'Add at least one Scenario with Given-When-Then steps.',
        });
      }
      return diags;
    },
  },
];

// ---------------------------------------------------------------------------
// Lint Engine
// ---------------------------------------------------------------------------

export function lintSpecification(
  parsed: ParsedFeature,
  sourceFile: string = 'unknown.feature',
  options: LintOptions = {}
): LintResult {
  const threshold = options.threshold ?? 70;
  const constitution = options.constitution ?? loadConstitution();
  const disabledRules = new Set(options.disabledRules || []);

  const allDiagnostics: LintDiagnostic[] = [];

  for (const rule of LINT_RULES) {
    if (disabledRules.has(rule.id)) continue;

    try {
      const diags = rule.check(parsed, { ...options, constitution });
      allDiagnostics.push(...diags);
    } catch (e) {
      // Silently skip failed rules
    }
  }

  // Calculate score
  const errorCount = allDiagnostics.filter(d => d.severity === 'error').length;
  const warningCount = allDiagnostics.filter(d => d.severity === 'warning').length;
  const infoCount = allDiagnostics.filter(d => d.severity === 'info').length;

  // Scoring: errors = -15pts, warnings = -5pts, info = -1pt
  const rawScore = 100 - (errorCount * 15) - (warningCount * 5) - (infoCount * 1);
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    file: sourceFile,
    featureName: parsed.featureName,
    diagnostics: allDiagnostics,
    score,
    passed: score >= threshold,
  };
}

// ---------------------------------------------------------------------------
// Get Available Rules (for help/documentation)
// ---------------------------------------------------------------------------

export function getAvailableRules(): { id: string; name: string; severity: LintSeverity }[] {
  return LINT_RULES.map(r => ({
    id: r.id,
    name: r.name,
    severity: r.severity,
  }));
}
