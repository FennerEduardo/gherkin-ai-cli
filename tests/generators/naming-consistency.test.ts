import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveFeatureForOutput } from '../../src/plugins/core-generators-plugin';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { defaultConfig } from '../../src/core/config';
import { generateCsharpContracts } from '../../src/generators/contracts-csharp';
import { generateCqrsHandlers } from '../../src/generators/dotnet/cqrs-handlers-generator';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';
import { featurePascalName } from '../../src/utils/naming';

const FEATURE = [
  '# language: es',
  'Característica: Ejecución de Saga y Comandos CQRS en .NET 8',
  '  Escenario: Pedido',
  '    Dado un cliente',
  '    Cuando MediatR envía el comando',
  '    Entonces el pedido queda registrado'
].join('\n');

describe('identifier naming is shared by every generator', () => {
  it('derives one canonical name from accented feature names with digits', () => {
    expect(featurePascalName('Ejecución de Saga y Comandos CQRS en .NET 8')).toBe('EjecucionDeSagaYComandosCqrsEnNet8');
    expect(featurePascalName('8 ball')).toBe('Feature8Ball');
    expect(buildDomainModel(parseGherkinText(FEATURE)).pascal).toBe('EjecucionDeSagaYComandosCqrsEnNet8');
  });

  it('C# handlers only reference command and read-model types the contracts declare', () => {
    const parsed = parseGherkinText(FEATURE);
    const config = { ...defaultConfig, projectName: 'Demo', stack: { ...defaultConfig.stack, language: 'csharp' } };
    const contracts = generateCsharpContracts(parsed, buildIR(parsed, 'f.feature'), config);
    const handlers = generateCqrsHandlers('Demo', parsed.featureName);
    const referenced = new Set([...handlers.matchAll(/\b(Create\w+Command|Get\w+Query|\w+ReadModel)\b/g)].map(m => m[1]));
    expect(referenced.size).toBeGreaterThan(0);
    for (const type of referenced) expect(contracts, type).toMatch(new RegExp(`record ${type}\\b`));
  });
});

describe('@aggregate tag', () => {
  // FEATURE with a feature-level tag between the language comment and the title.
  const tagged = (tag: string) => parseGherkinText(['# language: es', tag, ...FEATURE.split('\n').slice(1)].join('\n'));

  it.each(['@aggregate:Pedido', '@aggregate(Pedido)', '@Aggregate=pedido'])('%s overrides the name derived from the title', tag => {
    const parsed = tagged(tag);
    expect(featurePascalName(parsed)).toBe('Pedido');
    expect(buildDomainModel(parsed)).toMatchObject({ pascal: 'Pedido', kebab: 'pedido', snake: 'pedido' });
  });

  it('is applied consistently by contracts and pattern generators', () => {
    const parsed = tagged('@aggregate:PurchaseOrder');
    const config = { ...defaultConfig, projectName: 'Demo', stack: { ...defaultConfig.stack, language: 'csharp' } };
    const contracts = generateCsharpContracts(parsed, buildIR(parsed, 'f.feature'), config);
    expect(contracts).toContain('PurchaseOrderAggregate');
    expect(contracts).not.toContain('EjecucionDeSaga');
    const handlers = generateCqrsHandlers('Demo', buildDomainModel(parsed).pascal);
    for (const type of new Set([...handlers.matchAll(/\b(Create\w+Command|\w+ReadModel)\b/g)].map(m => m[1]))) {
      expect(contracts, type).toMatch(new RegExp(`record ${type}\\b`));
    }
  });

  it('without the tag the title is used', () => {
    expect(featurePascalName(parseGherkinText(FEATURE))).toBe('EjecucionDeSagaYComandosCqrsEnNet8');
  });
});

describe('feature binding relative to outputDir', () => {
  const ir = (sourceFile: string) => ({ sourceFile } as any);
  const base = { ...defaultConfig };

  it('binds in place when the feature is inside the output directory', () => {
    expect(resolveFeatureForOutput(ir('features/pay.feature'), { ...base, outputDir: './' }, '/repo')).toEqual({ featureFile: 'features/pay.feature' });
  });

  it('copies a feature that lives outside outputDir into <outputDir>/features/', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-feat-'));
    fs.mkdirSync(path.join(repo, 'features'));
    fs.writeFileSync(path.join(repo, 'features', 'pay.feature'), 'Feature: Pay\n');
    const res = resolveFeatureForOutput(ir('features/pay.feature'), { ...base, outputDir: './generated-specs' }, repo);
    expect(res.featureFile).toBe('features/pay.feature');
    expect(res.copy).toMatchObject({ filePath: 'features/pay.feature', content: 'Feature: Pay\n' });
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
