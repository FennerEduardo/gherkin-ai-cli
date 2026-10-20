/* ==========================================================================
   gherkin-ai-cli - IR builder: Constraints, policies and field specifications
   ========================================================================== */

import { ParsedFeature } from '../parsers/specification-interface';
import { FieldSpec, ValidationRule, Constraint, Policy } from '../semantic-ir';
import { Constitution } from '../constitution';
import { generateId, AUTH_PATTERNS } from './patterns';

// ---------------------------------------------------------------------------
// Constraint Extraction
// ---------------------------------------------------------------------------

export function extractConstraints(
  parsed: ParsedFeature,
  constitution: Constitution | null,
  sourceFile: string
): Constraint[] {
  const constraints: Constraint[] = [];

  // From constitution
  if (constitution) {
    if (constitution.architecture?.required) {
      for (const req of constitution.architecture.required) {
        constraints.push({
          id: generateId('CST'),
          level: 'must',
          description: req,
          category: 'architecture',
          evidence: ['constitution.yaml'],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'constitution',
        });
      }
    }
    if (constitution.architecture?.forbidden) {
      for (const fb of constitution.architecture.forbidden) {
        constraints.push({
          id: generateId('CST'),
          level: 'must-not',
          description: fb,
          category: 'architecture',
          evidence: ['constitution.yaml'],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'constitution',
        });
      }
    }
  }

  // From tags
  for (const tag of parsed.tags) {
    if (tag.startsWith('@security') || tag.startsWith('@seguridad')) {
      constraints.push({
        id: generateId('CST'),
        level: 'must',
        description: `Security requirement: ${tag}`,
        category: 'security',
        evidence: [tag],
        source: { file: sourceFile, line: 0 },
        confidence: 1.0,
        inferenceSource: 'deterministic',
      });
    }
    if (tag.startsWith('@compliance') || tag.startsWith('@cumplimiento')) {
      constraints.push({
        id: generateId('CST'),
        level: 'must',
        description: `Compliance requirement: ${tag}`,
        category: 'compliance',
        evidence: [tag],
        source: { file: sourceFile, line: 0 },
        confidence: 1.0,
        inferenceSource: 'deterministic',
      });
    }
  }

  return constraints;
}

// ---------------------------------------------------------------------------
// Policy Extraction
// ---------------------------------------------------------------------------

export function extractPolicies(
  parsed: ParsedFeature,
  constitution: Constitution | null,
  sourceFile: string
): Policy[] {
  const policies: Policy[] = [];

  if (constitution?.security) {
    policies.push({
      id: generateId('POL'),
      name: 'Security Policy',
      type: 'security',
      rules: [
        `Data classification: ${constitution.security.dataClassification}`,
        `Auth provider: ${constitution.security.authProvider}`,
        constitution.security.secretsPolicy,
      ].filter(Boolean),
      source: { file: sourceFile, line: 0 },
      confidence: 1.0,
      inferenceSource: 'constitution',
    });
  }

  // Detect authorization policies from scenarios
  const hasAuthScenarios = parsed.scenarios.some(sc =>
    sc.steps.some(s => AUTH_PATTERNS.some(p => p.test(s.text)))
  );

  if (hasAuthScenarios) {
    policies.push({
      id: generateId('POL'),
      name: 'Authorization Policy',
      type: 'authorization',
      rules: ['Authentication required for this feature'],
      source: { file: sourceFile, line: 0 },
      confidence: 0.85,
      inferenceSource: 'deterministic',
    });
  }

  return policies;
}
// ---------------------------------------------------------------------------
// Field Helpers
// ---------------------------------------------------------------------------

export function inferFieldType(
  currentType: string,
  name: string
): FieldSpec['type'] {
  if (currentType === 'number') return 'number';
  if (/email/i.test(name)) return 'string';
  if (/date|created_at|updated_at|timestamp|fecha/i.test(name)) return 'date';
  if (/id|uuid/i.test(name)) return 'string';
  if (/price|amount|total|cost|peso|monto|precio/i.test(name)) return 'number';
  if (/count|quantity|cantidad|numero|number/i.test(name)) return 'number';
  if (/is_|has_|active|enabled|visible/i.test(name)) return 'boolean';
  if (/status|estado|type|tipo|role|rol/i.test(name)) return 'enum';
  return 'string';
}

export function extractValidationRules(validations: string[]): ValidationRule[] {
  const rules: ValidationRule[] = [];

  for (const v of validations) {
    if (v === '@validate:email') {
      rules.push({ type: 'email', source: v });
    }
    if (v === '@validate:uuid') {
      rules.push({ type: 'uuid', source: v });
    }
    const rangeMatch = v.match(/@range\((\d+),(\d+)\)/);
    if (rangeMatch) {
      rules.push({
        type: 'range',
        params: { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) },
        source: v,
      });
    }
    const minMatch = v.match(/@min\((\d+)\)/);
    if (minMatch) {
      rules.push({ type: 'min', params: { value: parseInt(minMatch[1]) }, source: v });
    }
    const maxMatch = v.match(/@max\((\d+)\)/);
    if (maxMatch) {
      rules.push({ type: 'max', params: { value: parseInt(maxMatch[1]) }, source: v });
    }
    const minLenMatch = v.match(/@minLength\((\d+)\)/);
    if (minLenMatch) {
      rules.push({ type: 'minLength', params: { value: parseInt(minLenMatch[1]) }, source: v });
    }
    const maxLenMatch = v.match(/@maxLength\((\d+)\)/);
    if (maxLenMatch) {
      rules.push({ type: 'maxLength', params: { value: parseInt(maxLenMatch[1]) }, source: v });
    }
    const patternMatch = v.match(/@pattern\((.+)\)/);
    if (patternMatch) {
      rules.push({ type: 'pattern', params: { regex: patternMatch[1] }, source: v });
    }
  }

  return rules;
}

export function enrichFields(fields: FieldSpec[]): FieldSpec[] {
  // Add inferred validations based on field names
  for (const field of fields) {
    if (/email/i.test(field.name) && !field.validations.some(v => v.type === 'email')) {
      field.validations.push({ type: 'email', source: 'field-name-inference' });
    }
    if (/uuid|id$/i.test(field.name) && !field.validations.some(v => v.type === 'uuid')) {
      field.validations.push({ type: 'uuid', source: 'field-name-inference' });
    }
  }
  return fields;
}
