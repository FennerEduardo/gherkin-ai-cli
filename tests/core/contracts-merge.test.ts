import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectFeatureContracts, featureContractSlug, mergeAsyncApi, mergeOpenApi } from '../../src/core/contracts/merge';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { CoreContractsPlugin } from '../../src/plugins/core-generators-plugin';

const feature = (name: string, verb: string) => `Feature: ${name}
  Scenario: ${verb} works
    Given a valid request
    When the user ${verb} the ${name.toLowerCase()}
    Then the response status is 201
    And a ${name.replace(/\s/g, '')}${verb.charAt(0).toUpperCase() + verb.slice(1)} event is published
`;

describe('contract merge', () => {
  it('names the contracts directory after the feature file', () => {
    expect(featureContractSlug('features/01-place-order.feature', 'Place order')).toBe('01-place-order');
    expect(featureContractSlug(undefined, 'Course Catalog')).toBe('course-catalog');
  });

  it('unions paths, methods and components', () => {
    const a = { openapi: '3.0.3', info: { title: 'A' }, paths: { '/orders': { post: { operationId: 'a' } } }, components: { schemas: { A: {} } } };
    const b = { openapi: '3.0.3', info: { title: 'B' }, paths: { '/orders': { get: { operationId: 'b' } }, '/refunds': { post: {} } }, components: { schemas: { B: {} } } };
    const merged = mergeOpenApi([a, b], 'shop');
    expect(Object.keys(merged.paths['/orders']).sort()).toEqual(['get', 'post']);
    expect(merged.paths['/refunds']).toBeDefined();
    expect(Object.keys(merged.components.schemas).sort()).toEqual(['A', 'B']);
    expect(merged.info.title).toBe('shop API');
  });

  it('unions AsyncAPI channels', () => {
    const merged = mergeAsyncApi([{ asyncapi: '2.6.0', channels: { a: {} } }, { asyncapi: '2.6.0', channels: { b: {} } }], 'shop');
    expect(Object.keys(merged.channels)).toEqual(['a', 'b']);
  });

  describe('generate', () => {
    let dir: string;
    let cwd: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-contracts-'));
      cwd = process.cwd();
      process.chdir(dir);
    });
    afterEach(() => {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const config = { projectName: 'shop', architecture: 'hexagonal', outputDir: './', stack: { language: 'java', framework: 'spring', orm: 'jpa', database: 'postgresql', messaging: 'rabbitmq' }, rules: {} } as any;
    const run = (file: string, text: string) => {
      const artifacts = new CoreContractsPlugin().generate(buildIR(parseGherkinText(text), file), config);
      for (const a of artifacts) {
        fs.mkdirSync(path.dirname(path.join(dir, a.filePath)), { recursive: true });
        fs.writeFileSync(path.join(dir, a.filePath), a.content);
      }
      return artifacts.map(a => a.filePath);
    };

    it('keeps the first feature in the root contracts after generating a second one', () => {
      const first = run('features/orders.feature', feature('Orders', 'creates'));
      expect(first).toContain('contracts/orders/openapi.json');
      run('features/refunds.feature', feature('Refunds', 'requests'));

      const root = JSON.parse(fs.readFileSync(path.join(dir, 'openapi.json'), 'utf8'));
      const ordersPaths = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'contracts/orders/openapi.json'), 'utf8')).paths);
      const refundsPaths = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'contracts/refunds/openapi.json'), 'utf8')).paths);
      expect(ordersPaths.length).toBeGreaterThan(0);
      for (const p of [...ordersPaths, ...refundsPaths]) expect(root.paths[p]).toBeDefined();

      const channels = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'asyncapi.json'), 'utf8')).channels);
      expect(channels.some(c => c.startsWith('orders/'))).toBe(true);
      expect(channels.some(c => c.startsWith('refunds/'))).toBe(true);
      expect(collectFeatureContracts(dir, 'openapi.json', 'x', undefined)).toHaveLength(2);
    });
  });
});
