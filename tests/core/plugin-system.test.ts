import fsMod from 'fs';
import osMod from 'os';
import pathMod from 'path';
import { defaultConfig } from '../../src/core/config';
import { PolicyError } from '../../src/core/errors';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginRegistry, GherkinAIPlugin } from '../../src/core/plugin-system';
import { SpecificationIR } from '../../src/core/semantic-ir';
import { GherkinAIConfig } from '../../src/core/config';

describe('Plugin System', () => {
  let registry: PluginRegistry;

  const mockConfig: GherkinAIConfig = {
    projectName: 'test',
    specDir: './specs',
    outputDir: './out',
    projectMode: 'greenfield',
    architecture: 'hexagonal',
    stack: { language: 'typescript', framework: 'nest', orm: 'prisma' }
  };

  const mockIR: SpecificationIR = {
    features: [], actors: [], commands: [], queries: [], domainEvents: [],
    stateMachines: [], invariants: [], apiEndpoints: [], constraints: [],
    policies: [], assumptions: [], risks: [], traceability: { features: {}, scenarios: {}, links: [] }
  };

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('should register plugins', () => {
    const plugin: GherkinAIPlugin = { name: 'test-plugin', version: '1.0' };
    registry.register(plugin);
    expect(registry.getPlugins().length).toBe(1);
    expect(registry.getPlugins()[0].name).toBe('test-plugin');
  });

  it('should prevent duplicate registration', () => {
    const plugin: GherkinAIPlugin = { name: 'test-plugin', version: '1.0' };
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow('already registered');
  });

  it('should call onInit when initialized', () => {
    const onInitFn = vi.fn();
    const plugin: GherkinAIPlugin = { name: 'test-plugin', version: '1.0', onInit: onInitFn };
    
    registry.register(plugin);
    registry.initialize({ config: mockConfig, constitution: null, projectDir: '/tmp' });
    
    expect(onInitFn).toHaveBeenCalledWith({ config: mockConfig, constitution: null, projectDir: '/tmp' });
  });

  it('should run analysis phase across plugins', () => {
    const plugin1: GherkinAIPlugin = { 
      name: 'p1', version: '1.0', 
      analyze: () => ({ warnings: ['w1'] }) 
    };
    const plugin2: GherkinAIPlugin = { 
      name: 'p2', version: '1.0', 
      analyze: () => ({ recommendations: ['r1'] }) 
    };
    const plugin3: GherkinAIPlugin = { name: 'p3', version: '1.0' }; // no analyze

    registry.register(plugin1);
    registry.register(plugin2);
    registry.register(plugin3);

    const results = registry.runAnalysis(mockIR);
    expect(results.length).toBe(2);
    expect(results[0].warnings).toEqual(['w1']);
    expect(results[1].recommendations).toEqual(['r1']);
  });

  it('should run generation phase across plugins', () => {
    const plugin1: GherkinAIPlugin = { 
      name: 'p1', version: '1.0', 
      generate: () => [{ filePath: 'a.ts', content: 'code', type: 'contract' }] 
    };
    registry.register(plugin1);

    const artifacts = registry.runGeneration(mockIR, mockConfig);
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].filePath).toBe('a.ts');
  });
});

describe('PluginRegistry.loadFromConfig (governed loading)', () => {

  function project() {
    const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'ghk-plugin-'));
    fsMod.writeFileSync(pathMod.join(dir, 'my-plugin.js'), "module.exports = { plugin: { name: 'local-plugin', version: '1.0.0' } };");
    return dir;
  }

  it('loads a local plugin once, even when called repeatedly', () => {
    const dir = project();
    const registry = new PluginRegistry();
    const config = { ...defaultConfig, plugins: { load: ['./my-plugin.js'] } };
    expect(registry.loadFromConfig(config, dir)).toEqual(['./my-plugin.js']);
    expect(registry.loadFromConfig(config, dir)).toEqual([]);
    expect(registry.getPlugins().map(p => p.name)).toEqual(['local-plugin']);
  });

  it('enforces the organization allow-list', () => {
    const dir = project();
    const registry = new PluginRegistry();
    const config = { ...defaultConfig, plugins: { load: ['./my-plugin.js'], allow: ['@corp/approved-plugin'] } };
    expect(() => registry.loadFromConfig(config, dir)).toThrow(PolicyError);
  });

  it('refuses plugin paths outside the project', () => {
    const dir = project();
    const registry = new PluginRegistry();
    expect(() => registry.loadFromConfig({ ...defaultConfig, plugins: { load: ['../elsewhere/evil.js'] } }, dir)).toThrow(PolicyError);
  });
});
