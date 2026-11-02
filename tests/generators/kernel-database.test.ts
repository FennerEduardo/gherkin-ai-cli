/* ==========================================================================
   M-04 (PLAN-3.3.0): the generated infrastructure follows the database the
   runtime kernel runs on. Until 3.2.2 the compose file and .env.example
   followed stack.database, so a project declaring "mysql" without
   stack.kernelDatabase got a MySQL container and a mysql:// URL for a
   kernel that speaks PostgreSQL.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { generateInfra } from '../../src/generators/infra';
import { databaseMismatch, kernelDatabase } from '../../src/generators/kernel/runtime/typescript-mysql';

const config = (stack: Record<string, string>) => ({ ...defaultConfig, projectName: 'shop', stack: { ...defaultConfig.stack, ...stack } }) as any;

describe('kernel database (M-04)', () => {
  it('is MySQL only when asked for, in a runtime whose kernel supports it', () => {
    expect(kernelDatabase(config({ language: 'typescript', database: 'mysql' }))).toBe('postgresql');
    expect(kernelDatabase(config({ language: 'typescript', database: 'mysql', kernelDatabase: 'mysql' }))).toBe('mysql');
    expect(kernelDatabase(config({ language: 'php', database: 'mysql', kernelDatabase: 'mysql' }))).toBe('postgresql');
  });

  it('compose and .env.example use the kernel database, so the app and its database service agree', () => {
    const declared = generateInfra(config({ language: 'typescript', framework: 'nestjs', database: 'mysql' }));
    expect(declared.dockerComposeYaml).toContain('image: postgres:16-alpine');
    expect(declared.dockerComposeYaml).not.toContain('mysql:8.0');
    expect(declared.envExample).toMatch(/DATABASE_URL=postgresql:\/\//);

    const mysql = generateInfra(config({ language: 'typescript', framework: 'nestjs', database: 'mysql', kernelDatabase: 'mysql' }));
    expect(mysql.dockerComposeYaml).toContain('image: mysql:8.0');
    expect(mysql.envExample).toMatch(/DATABASE_URL=mysql:\/\//);
  });

  it('generate warns when the declared database is not the one the service runs on', () => {
    expect(databaseMismatch(config({ language: 'typescript', database: 'mysql' }))).toMatch(/stack\.database is "mysql" but the runtime kernel runs on PostgreSQL.*kernelDatabase "mysql"/);
    expect(databaseMismatch(config({ language: 'go', database: 'mongodb' }))).toMatch(/runs on PostgreSQL/);
    expect(databaseMismatch(config({ language: 'typescript', database: 'postgresql' }))).toBeUndefined();
    expect(databaseMismatch(config({ language: 'typescript', database: 'mysql', kernelDatabase: 'mysql' }))).toBeUndefined();
  });
});
