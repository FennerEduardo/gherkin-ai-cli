/* ==========================================================================
   Industry rules over the contracts (PLAN-3.2.2 X-03): banking, health, telecom
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { checkContracts, schemaProperties } from '../../src/core/profiles/industries/contract-rules';

const ids = (industry: string, doc: any) => checkContracts(industry, doc).map(d => d.ruleId);

describe('banking', () => {
  const payment = (amount: any, extra: Record<string, any> = {}) => ({
    components: { schemas: { PaymentInstruction: { type: 'object', properties: { amount, ...extra } } } }
  });

  it('GHK151: a floating-point amount is an error', () => {
    const [d] = checkContracts('banking', payment({ type: 'number', format: 'double' }, { currency: { type: 'string' } }));
    expect(d).toMatchObject({ ruleId: 'GHK151', severity: 'error', location: '#/components/schemas/PaymentInstruction/properties/amount' });
  });

  it('a decimal amount with its currency passes', () => {
    expect(ids('banking', payment({ type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' }, { currency: { type: 'string', pattern: '^[A-Z]{3}$' } }))).toEqual([]);
  });

  it('GHK152: an amount without a currency next to it', () => {
    expect(ids('banking', payment({ type: 'string' }))).toEqual(['GHK152']);
  });

  it('GHK153: IBAN and BIC without a format', () => {
    expect(ids('banking', { components: { schemas: { Account: { properties: { iban: { type: 'string' }, bic: { type: 'string', pattern: '^[A-Z0-9]{8,11}$' } } } } } })).toEqual(['GHK153']);
  });

  it('GHK154: card data in a request body, also inline', () => {
    const doc = { paths: { '/payments': { post: { requestBody: { content: { 'application/json': { schema: { properties: { pan: { type: 'string' } } } } } } } } } };
    expect(checkContracts('banking', doc)[0]).toMatchObject({ ruleId: 'GHK154', location: 'POST /payments request application/json/properties/pan' });
  });

  it('honours industry.disabledRules', () => {
    expect(checkContracts('banking', payment({ type: 'string' }), ['GHK152'])).toEqual([]);
  });
});

describe('health', () => {
  it('GHK451: a schema named like a FHIR resource needs resourceType', () => {
    expect(ids('health', { components: { schemas: { Patient: { properties: { id: { type: 'string' } } } } } })).toEqual(['GHK451']);
    expect(ids('health', { components: { schemas: { Patient: { properties: { resourceType: { const: 'Patient' } } } } } })).toEqual([]);
  });

  it('GHK452: an operation that returns PHI needs a security requirement', () => {
    const op = { responses: { '200': { content: { 'application/json': { schema: { properties: { birthDate: { type: 'string' } } } } } } } };
    expect(ids('health', { paths: { '/patients/{id}': { get: op } } })).toEqual(['GHK452']);
    expect(ids('health', { security: [{ bearer: [] }], paths: { '/patients/{id}': { get: op } } })).toEqual([]);
    expect(ids('health', { security: [{ bearer: [] }], paths: { '/patients/{id}': { get: { ...op, security: [] } } } })).toEqual(['GHK452']);
  });
});

describe('telecom', () => {
  it('GHK251: TM Forum entities carry id, href and @type', () => {
    const [d] = checkContracts('telecom', { components: { schemas: { ProductOrder: { properties: { id: {}, state: {} } } } } });
    expect(d).toMatchObject({ ruleId: 'GHK251', message: expect.stringContaining('href, @type') });
  });
});

describe('scope', () => {
  it('other industries and missing documents check nothing', () => {
    expect(checkContracts('generic', { components: { schemas: { X: { properties: { amount: { type: 'number', format: 'float' } } } } } })).toEqual([]);
    expect(checkContracts('banking', undefined)).toEqual([]);
  });

  it('walks nested objects and arrays', () => {
    const sites = schemaProperties({ components: { schemas: { A: { properties: { lines: { type: 'array', items: { properties: { amount: { type: 'number' } } } } } } } } });
    expect(sites.map(s => s.location)).toContain('#/components/schemas/A/properties/lines/items/properties/amount');
  });
});
