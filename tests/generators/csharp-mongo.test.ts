/* ==========================================================================
   The .NET runtime kernel on MongoDB (stack.kernelDatabase "mongodb";
   PLAN-3.3.0 X-02). The golden dotnet-mongo runs IT1-IT7 against a MongoDB 8
   replica set; this checks the generated sources and the csproj.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const config = { ...defaultConfig, projectName: 'Payments', stack: { ...defaultConfig.stack, language: 'csharp', framework: 'aspnet', database: 'mongodb', kernelDatabase: 'mongodb' } } as any;

describe('.NET kernel on MongoDB (X-02)', () => {
  it('no Npgsql or SQL is left; KernelDatabase replaces the data source', () => {
    const files = generatePresets(parsed, config);
    const root = generateContracts(parsed, buildIR(parsed, 'f.feature'), config).projectRootFile;
    files.push(...(Array.isArray(root) ? root : root ? [root] : []));
    const byName = new Map(files.map(f => [f.filename, f.content]));
    const all = files.filter(f => /\.(cs|csproj)$/.test(f.filename)).map(f => f.content).join('\n');
    expect(all).not.toMatch(/Npgsql|ON CONFLICT|SKIP LOCKED|DROP SCHEMA|INSERT INTO|CreateCommand/);
    expect(all).toContain('<PackageReference Include="MongoDB.Driver" Version="3.4.0" />');
    expect(byName.get('src/Runtime/Connections.cs')).toContain('public async Task<T> InTransactionAsync<T>');
    expect(byName.get('src/Runtime/OutboxRelay.cs')).toContain('FindOneAndUpdateAsync');
    expect(byName.get('src/Api/Program.cs')).toContain('GetRequiredService<KernelDatabase>()');
  });
});
