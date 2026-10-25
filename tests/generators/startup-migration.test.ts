import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { RUNTIME_SCHEMA_SQL, RUNTIME_TABLES_SQL } from '../../src/generators/kernel/runtime/shared';

// Until 3.2.1 only the HTTP integration tests created the kernel's tables: a service deployed against an
// empty database answered 500 to its first command (relation "public.ghk_idempotency" does not exist). The
// golden image smoke did not see it because it reused the database the integration suite had migrated.
const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const STACKS: [string, string][] = [
  ['java', 'spring-boot'], ['java', 'quarkus'], ['kotlin', 'spring-boot'], ['kotlin', 'quarkus'], ['csharp', 'dotnet'],
  ['typescript', 'nestjs'], ['typescript', 'express'], ['python', 'fastapi'], ['python', 'django'], ['go', 'chi'],
  ['php', 'laravel'], ['ruby', 'rails'], ['elixir', 'phoenix'], ['rust', 'axum']
];
const TEST_FILE = /(^|\/)(tests?|spec|__tests__|test_)|_test\.|\.test\.|\.spec\.|Test\.java$|Tests?\.cs$|_spec\.rb$|_test\.exs$|(^|\/)tests\//;
const MIGRATE_CALL = /\bmigrate\(|Migrate(Async)?\(|migrate_on_start\(\)|RuntimeSchema\.migrate|Schema::migrate|migrateRuntimeSchema\(\)|:ghk_runtime_schema/;

describe('backends create the kernel tables when they start', () => {
  it('migrate is one atomic statement that takes an advisory lock first', () => {
    expect(RUNTIME_SCHEMA_SQL).toHaveLength(1);
    expect(RUNTIME_SCHEMA_SQL[0]).toMatch(/^DO \$\$ BEGIN PERFORM pg_advisory_xact_lock\(hashtext\('ghk_runtime_schema'\)\);/);
    for (const table of RUNTIME_TABLES_SQL) expect(RUNTIME_SCHEMA_SQL[0]).toContain(`${table};`);
  });

  it.each(STACKS)('%s/%s: the startup code migrates, unless GHK_MIGRATE=false', (language, framework) => {
    const files = generatePresets(parsed, { ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language, framework } });
    const startup = files.filter(f => !TEST_FILE.test(f.filename) && MIGRATE_CALL.test(f.content) && /GHK_MIGRATE|ghk\.schema\.migrate/.test(f.content));
    expect(startup.map(f => f.filename), 'a non-test file calls migrate behind GHK_MIGRATE').not.toEqual([]);
  });
});
