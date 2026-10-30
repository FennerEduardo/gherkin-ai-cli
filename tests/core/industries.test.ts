import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { lintSpecification } from '../../src/core/specification-linter';
import { buildIR } from '../../src/core/ir-builder';
import { partialConfigSchema } from '../../src/core/config';
import {
  INDUSTRIES, INDUSTRY_IDS, CAPABILITY_DEPTH_RULE, industryProfileSchema, resolveIndustry, industryForConfig, suggestedIndustry,
  industryLintOptions, renderIndustryGuidance, renderIndustryContextJson, renderIndustryContextMarkdown
} from '../../src/core/profiles/industries';

/** A feature with optional feature tags and scenarios given as [tags, name, ...steps]. */
const feature = (tags: string, ...scenarios: string[][]) => [
  tags,
  'Feature: Sample capability',
  ...scenarios.flatMap(([stags, name, ...steps]) => [stags ? `  ${stags}` : '', `  Scenario: ${name}`, ...steps.map(s => `    ${s}`)])
].filter(Boolean).join('\n');

const BASIC = ['', 'Happy path', 'Given a request', 'When it is processed', 'Then it is accepted'];

// [rule id, feature that triggers it, feature that satisfies it]
const CASES: [string, string, string][] = [
  ['GHK101', feature('', BASIC), feature('@bian:PaymentExecution', BASIC)],
  ['GHK102', feature('@bian:PaymentExecution', ['@bian:CurrentAccount', 'Open', 'Given a request', 'When it is processed', 'Then it is accepted']), feature('@bian:PaymentExecution', BASIC)],
  ['GHK103',
    feature('', ['', 'Pay an invoice', 'Given an invoice', 'When the customer pays the invoice', 'Then the payment is recorded']),
    feature('', ['', 'Pay an invoice', 'Given an invoice', 'When the customer pays the invoice', 'Then the payment is recorded'], ['', 'Duplicate request', 'Given a paid invoice', 'When the same request is sent twice', 'Then only one payment is recorded'])],
  ['GHK104', feature('', ['', 'Pay', 'Given a payer with an account', 'When it is processed', 'Then it is accepted']), feature('', ['', 'Pay', 'Given a debtor with an account', 'When it is processed', 'Then it is accepted'])],

  ['GHK201', feature('@tmf:622', BASIC), feature('@tmf:TMF622', BASIC)],
  ['GHK202', feature('', ['', 'Order', 'Given a subscriber', 'When it is processed', 'Then it is accepted']), feature('', ['', 'Order', 'Given a customer', 'When it is processed', 'Then it is accepted'])],
  ['GHK203', feature('', ['', 'Order', 'Given a customer', 'When the customer clicks the order button', 'Then it is accepted']), feature('', ['', 'Order', 'Given a customer', 'When the customer orders the product', 'Then it is accepted'])],

  ['GHK301', feature('@isa95:plant', BASIC), feature('@isa95:acme/plant-a/assembly', BASIC)],
  ['GHK302', feature('', ['', 'Monitor', 'Given a machine on line 1', 'When it is processed', 'Then it is accepted']), feature('@aas:TechnicalData', ['', 'Monitor', 'Given a machine on line 1', 'When it is processed', 'Then it is accepted'])],
  ['GHK303', feature('', ['', 'Close', 'Given a temperature reading of 90', 'When the work order is closed', 'Then it is accepted']), feature('', ['', 'Close', 'Given a completed work order', 'When the work order is closed', 'Then it is accepted'])],

  ['GHK401', feature('@fhir:Patients', BASIC), feature('@fhir:Patient', BASIC)],
  ['GHK402', feature('', ['', 'Read', 'Given a registered patient', 'When the clinician reads the patient record', 'Then the record is returned']), feature('', ['', 'Read', 'Given the clinician is authorized for the patient', 'When the clinician reads the patient record', 'Then the record is returned'])],
  ['GHK403', feature('', ['', 'Register', 'Given a person with email "john@example.com"', 'When it is processed', 'Then it is accepted']), feature('', ['', 'Register', 'Given a person "person-001"', 'When it is processed', 'Then it is accepted'])],

  ['GHK501', feature('@scor:Order', BASIC), feature('@scor:O1', BASIC)],
  ['GHK502', feature('@scor-metric:perfect', BASIC), feature('@scor-metric:RL.1.1', BASIC)],
  ['GHK503', feature('', ['', 'Buy', 'Given a vendor', 'When it is processed', 'Then it is accepted']), feature('', ['', 'Buy', 'Given a supplier', 'When it is processed', 'Then it is accepted'])],

  ['GHK601', feature('', BASIC), feature('@acord:ClaimManagement', BASIC)],
  ['GHK602', feature('', ['', 'Quote', 'Given a client', 'When it is processed', 'Then it is accepted']), feature('', ['', 'Quote', 'Given a party', 'When it is processed', 'Then it is accepted'])],
  ['GHK603',
    feature('', ['', 'File', 'Given an active policy', 'When the claimant files a claim', 'Then the claim is approved']),
    feature('', ['', 'File', 'Given an active policy', 'When the claimant files a claim', 'Then the claim is approved'], ['', 'Deny', 'Given a lapsed policy', 'When the claimant files a claim', 'Then the claim is denied'])],

  ['GHK701', feature('', BASIC), feature('@iata:OrderCreate', BASIC)],
  ['GHK702', feature('', ['', 'Book', 'Given a PNR for the passenger', 'When it is processed', 'Then it is accepted']), feature('', ['', 'Book', 'Given an order for the passenger', 'When it is processed', 'Then it is accepted'])],
  ['GHK703', feature('', ['', 'Book', 'Given a passenger', 'When the customer places an order', 'Then it is accepted']), feature('', ['', 'Book', 'Given a priced offer', 'When the customer places an order', 'Then it is accepted'])],

  ['GHK801', feature('@autosar:classic', BASIC), feature('@autosar:adaptive', BASIC)],
  ['GHK802', feature('', ['', 'Brake', 'Given a braking request', 'When it is processed', 'Then the brake responds within 50 microseconds']), feature('', ['', 'Brake', 'Given a braking request', 'When it is processed', 'Then the backend records the brake event'])],
  ['GHK803', feature('@asil:D', BASIC), feature('@asil:B', BASIC)],

  ['GHK901',
    feature('', ['', 'Invite', 'Given a student who is a minor', 'When the administrator invites the student', 'Then the invitation is sent']),
    feature('', ['', 'Invite', 'Given a student who is a minor', 'When the administrator invites the student', 'Then the invitation waits for consent'], ['', 'Consent', 'Given a pending invitation of a minor', 'When the legal representative grants consent', 'Then the invitation is sent'])],
  ['GHK902',
    feature('', ['', 'Publish', 'Given a graded submission', 'When the teacher publishes the grade', 'Then the learner sees the grade']),
    feature('', ['', 'Publish', 'Given a graded submission', 'When the teacher publishes the grade', 'Then the learner sees the grade'], ['', 'Other learner', 'Given another learner', 'When they read the grade', 'Then access is denied'])],
  ['GHK903', feature('', ['', 'Enroll', 'Given a pupil', 'When it is processed', 'Then it is accepted']), feature('', ['', 'Enroll', 'Given a learner', 'When it is processed', 'Then it is accepted'])],

  ['GHK090', feature('@capability:a/b/c/d/e', BASIC), feature('@capability:a/b/c/d', BASIC)]
];

const allRules = [CAPABILITY_DEPTH_RULE, ...Object.values(INDUSTRIES).flatMap(p => p.lintRules)];
const ruleById = (id: string) => allRules.find(r => r.id === id)!;
const diagnostics = (id: string, text: string) => ruleById(id).check(parseGherkinText(text), {}).filter(d => d.ruleId === id);

describe('industry profiles', () => {
  it('registers the 9 industries plus generic, each valid against the schema', () => {
    expect(Object.keys(INDUSTRIES).sort()).toEqual([...INDUSTRY_IDS].sort());
    for (const p of Object.values(INDUSTRIES)) {
      const { lintRules, ...data } = p;
      expect(() => industryProfileSchema.parse(data), p.id).not.toThrow();
    }
  });

  it('gives every industry at least 3 lint rules with unique ids in its own range', () => {
    const ids = allRules.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    INDUSTRY_IDS.filter(id => id !== 'generic').forEach((id, i) => {
      const rules = INDUSTRIES[id].lintRules;
      expect(rules.length, id).toBeGreaterThanOrEqual(3);
      for (const r of rules) expect(r.id, `${id} ${r.id}`).toMatch(new RegExp(`^GHK${i + 1}\\d\\d$`));
    });
  });

  it('every rule has a triggering and a passing case', () => {
    expect(new Set(CASES.map(c => c[0]))).toEqual(new Set(allRules.map(r => r.id)));
  });

  it.each(CASES)('%s flags the violating feature and accepts the compliant one', (id, bad, good) => {
    expect(diagnostics(id, bad).length, 'violation').toBeGreaterThan(0);
    expect(diagnostics(id, good), 'compliant').toEqual([]);
  });

  it('aliases are unique and resolve to their industry', () => {
    const aliases = Object.values(INDUSTRIES).flatMap(p => p.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(resolveIndustry('salud')?.id).toBe('health');
    expect(resolveIndustry('TELCO')?.id).toBe('telecom');
    expect(resolveIndustry('unknown')).toBeUndefined();
  });

  it('only industry.id activates an industry; a legacy domainProfile just suggests one', () => {
    expect(industryForConfig({ domainProfile: 'payments' })).toBeUndefined();
    expect(suggestedIndustry({ domainProfile: 'payments' })?.id).toBe('banking');
    expect(industryForConfig({ domainProfile: 'payments', industry: { id: 'insurance' } })?.id).toBe('insurance');
    expect(suggestedIndustry({ domainProfile: 'payments', industry: { id: 'insurance' } })).toBeUndefined();
    expect(industryLintOptions({ domainProfile: 'payments' }).rules).toEqual([]);
  });
});

describe('industry rules in ghk lint', () => {
  const text = feature('@bian:PaymentExecution', ['@bian:CurrentAccount', 'Open', 'Given a request', 'When it is processed', 'Then it is accepted']);

  it('adds the project industry rules and honours industry.disabledRules', () => {
    const run = (config: any) => lintSpecification(parseGherkinText(text), 'f.feature', { constitution: null, ...industryLintOptions(config) });
    expect(run({}).diagnostics.some(d => d.ruleId === 'GHK102')).toBe(false);
    expect(run({ industry: { id: 'banking' } }).diagnostics.some(d => d.ruleId === 'GHK102')).toBe(true);
    expect(run({ industry: { id: 'banking', disabledRules: ['GHK102'] } }).diagnostics.some(d => d.ruleId === 'GHK102')).toBe(false);
  });
});

describe('industry guidance for the LLM', () => {
  const parsed = parseGherkinText(feature('', BASIC));

  it('adds the industry rules to the IR as must constraints without inventing commands or events', () => {
    const plain = buildIR(parsed, 'f.feature');
    const withIndustry = buildIR(parsed, 'f.feature', { industry: 'health' });
    expect(withIndustry.commands.map(c => c.name)).toEqual(plain.commands.map(c => c.name));
    expect(withIndustry.events.map(e => e.name)).toEqual(plain.events.map(e => e.name));
    const added = withIndustry.constraints.filter(c => c.description.startsWith('Industry Requirement (Healthcare)'));
    expect(added).toHaveLength(INDUSTRIES.health.guidance.rules.length);
    expect(added.every(c => c.level === 'must')).toBe(true);
    expect(withIndustry.policies.some(p => p.name === 'Healthcare Industry Standards Policy')).toBe(true);
    expect(buildIR(parsed, 'f.feature', { industry: 'generic' }).constraints).toEqual(plain.constraints);
  });

  it('renders a compact and a full prompt section', () => {
    const full = renderIndustryGuidance(INDUSTRIES.banking, { contextPath: '.ghe/industry-context.md' });
    const compact = renderIndustryGuidance(INDUSTRIES.banking, { compact: true, contextPath: '.ghe/industry-context.md' });
    for (const rule of INDUSTRIES.banking.guidance.rules) expect(full).toContain(rule);
    expect(full).toContain('not certification');
    expect(compact).toContain(INDUSTRIES.banking.guidance.compact);
    expect(compact).toContain('@.ghe/industry-context.md');
    expect(compact.length).toBeLessThan(full.length / 2);
  });

  it('writes a context file that cites every standard and lists the lint rules', () => {
    for (const p of Object.values(INDUSTRIES)) {
      const md = renderIndustryContextMarkdown(p);
      for (const s of p.standards) expect(md, p.id).toContain(s.url);
      for (const r of p.lintRules) expect(md, p.id).toContain(r.id);
      const json = JSON.parse(renderIndustryContextJson(p));
      expect(json.id).toBe(p.id);
      expect(json.lintRules.map((r: any) => r.id)).toContain('GHK090');
    }
  });
});

describe('industry config', () => {
  it('accepts a known industry and rejects an unknown one', () => {
    expect(partialConfigSchema.safeParse({ industry: { id: 'health', disabledRules: ['GHK403'] } }).success).toBe(true);
    expect(partialConfigSchema.safeParse({ industry: { id: 'mining' } }).success).toBe(false);
  });
});

describe('industry metadata in generated contracts', () => {
  it('tags OpenAPI / AsyncAPI with x-industry and adds the standards to the ADR', async () => {
    const { generateContracts } = await import('../../src/generators/contracts');
    const { defaultConfig } = await import('../../src/core/config');
    const parsed = parseGherkinText(feature('@bian:PaymentExecution', ['', 'Pay', 'Given a debtor', 'When the debtor pays the invoice', 'Then the payment is executed']));
    const ir = buildIR(parsed, 'f.feature', { industry: 'banking' });
    const out = generateContracts(parsed, ir, { ...defaultConfig, industry: { id: 'banking' } });
    expect(JSON.parse(out.openApiJson).info['x-industry']).toEqual({ id: 'banking', standards: ['BIAN', 'ISO20022'], classification: { bian: ['PaymentExecution'] } });
    expect(JSON.parse(out.asyncApiJson).info['x-industry'].id).toBe('banking');
    expect(out.adrMd).toContain('## Industry Standards (Banking & Financial Services)');
    expect(out.adrMd).toContain('@bian:PaymentExecution');

    const plain = generateContracts(parsed, buildIR(parsed, 'f.feature'), defaultConfig);
    expect(JSON.parse(plain.openApiJson).info['x-industry']).toBeUndefined();
    expect(plain.adrMd).not.toContain('Industry Standards');
  });
});
