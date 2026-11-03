/* ==========================================================================
   The .NET runtime kernel on MySQL (stack.kernelDatabase "mysql";
   PLAN-3.3.0 X-01b). The golden dotnet-mysql runs IT1-IT7 against MySQL 8.4;
   this checks the generated sources and the csproj.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const project = (kernelDatabase?: string) => {
  const config = { ...defaultConfig, projectName: 'Payments', stack: { ...defaultConfig.stack, language: 'csharp', framework: 'aspnet', database: 'mysql', ...(kernelDatabase ? { kernelDatabase } : {}) } } as any;
  const files = generatePresets(parsed, config);
  const root = generateContracts(parsed, buildIR(parsed, 'f.feature'), config).projectRootFile;
  files.push(...(Array.isArray(root) ? root : root ? [root] : []));
  return new Map(files.map(f => [f.filename, f.content]));
};
const text = (files: Map<string, string>) => [...files.entries()].filter(([n]) => /\.(cs|csproj)$/.test(n)).map(([, c]) => c).join('\n');

describe('.NET kernel on MySQL (X-01b)', () => {
  it('no PostgreSQL SQL, driver or $n parameter outside Exec is left', () => {
    const files = project('mysql');
    const all = text(files);
    expect(all).not.toMatch(/ON CONFLICT|RETURNING id|make_interval|DROP SCHEMA|using Npgsql|NpgsqlDataSource|Include="Npgsql"|[^.\w]now\(\)/);
    for (const line of all.split('\n').filter(l => !/\bExec\(/.test(l))) expect(line).not.toMatch(/\$\d/);
    expect(all).toMatch(/INSERT IGNORE INTO/);
    expect(all).toMatch(/ON DUPLICATE KEY UPDATE/);
    expect(all).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(all).toContain('<PackageReference Include="MySqlConnector" Version="2.4.0" />');
    expect(files.get('src/Runtime/Connections.cs')).toContain('IgnoreCommandTransaction = true');
    expect(files.get('src/Runtime/Schema.cs')).toContain("GET_LOCK('ghk_runtime_schema', 60)");
  });

  it('declaring "mysql" without kernelDatabase keeps the PostgreSQL kernel (M-04)', () => {
    const all = text(project());
    expect(all).toMatch(/ON CONFLICT/);
    expect(all).toMatch(/using Npgsql/);
  });
});
