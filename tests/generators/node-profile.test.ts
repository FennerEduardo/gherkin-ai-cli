import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { defaultConfig } from '../../src/core/config';
import { generateContracts } from '../../src/generators/contracts';
import { generatePresets } from '../../src/generators/presets';
import { generatePrismaStack } from '../../src/generators/prisma-stack';
import { getStackSupport } from '../../src/generators/stack-support';
import { majorOf, prismaClientImport, resolveNodeProfile, withEsmImportExtensions } from '../../src/generators/node-profile';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const cfg = (stack: Record<string, string> = {}) => ({ ...defaultConfig, projectName: 'shop', stack: { ...defaultConfig.stack, framework: 'nestjs', orm: 'prisma', database: 'postgresql', ...stack } });

/** Every file the plugins would write for this config. */
function project(config: ReturnType<typeof cfg>): Map<string, string> {
  const files = new Map<string, string>();
  const contracts = generateContracts(parsed, buildIR(parsed, 'f.feature'), config);
  const roots = Array.isArray(contracts.projectRootFile) ? contracts.projectRootFile : [contracts.projectRootFile!];
  for (const f of roots) files.set(f.filename, f.content);
  for (const f of generatePresets(parsed, config, 'features/checkout.feature')) files.set(f.filename, f.content);
  for (const f of generatePrismaStack(parsed, config)) files.set(f.filename, f.content);
  return files;
}
const pkg = (files: Map<string, string>) => JSON.parse(files.get('package.json')!);
const relativeImports = (files: Map<string, string>) =>
  [...files].filter(([name]) => name.endsWith('.ts')).flatMap(([name, src]) => [...src.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)].map(m => `${name}: ${m[1]}`));

describe('NestJS / Prisma version profile', () => {
  it('defaults to NestJS 11 + Prisma 6 (CommonJS) and parses majors from version ranges', () => {
    expect(resolveNodeProfile(cfg())).toMatchObject({ nest: '11', prisma: '6', esm: false, ext: '' });
    expect(resolveNodeProfile(cfg({ frameworkVersion: '^12.1.0', ormVersion: 'v7' }))).toMatchObject({ nest: '12', prisma: '7', esm: true, ext: '.js' });
    expect(majorOf('12.x')).toBe('12');
    // Versions only apply to the frameworks they describe.
    expect(resolveNodeProfile(cfg({ framework: 'express', frameworkVersion: '12' })).esm).toBe(false);
  });

  it('rejects unsupported majors and Prisma 7 with MongoDB as configuration errors', () => {
    expect(() => resolveNodeProfile(cfg({ frameworkVersion: '10' }))).toThrow(expect.objectContaining({ exitCode: 3 }));
    expect(() => resolveNodeProfile(cfg({ ormVersion: '5' }))).toThrow(/not supported for Prisma/);
    expect(() => resolveNodeProfile(cfg({ ormVersion: '7', database: 'mongodb' }))).toThrow(/MongoDB/);
  });

  it('adds .js to relative specifiers only', () => {
    const src = "import { A } from './a';\nimport type { B } from '../b/c';\nimport x from 'pkg/sub';\nimport './side';\nconst m = await import('./lazy');\nimport { D } from './d.js';";
    expect(withEsmImportExtensions(src)).toBe("import { A } from './a.js';\nimport type { B } from '../b/c.js';\nimport x from 'pkg/sub';\nimport './side.js';\nconst m = await import('./lazy.js');\nimport { D } from './d.js';");
  });

  it('keeps the default project unchanged: CommonJS, @prisma/client, prisma-client-js', () => {
    const files = project(cfg());
    expect(pkg(files).type).toBeUndefined();
    expect(pkg(files).dependencies['@nestjs/core']).toBe('^11.1.0');
    expect(pkg(files).dependencies['@prisma/client']).toBe('^6.19.0');
    expect(files.get('prisma/schema.prisma')).toContain('provider = "prisma-client-js"');
    expect(files.has('prisma.config.ts')).toBe(false);
    expect(files.get('src/prisma/prisma.service.ts')).toContain("from '@prisma/client'");
    expect(files.get('jest.config.js')).toContain('module.exports');
    expect(relativeImports(files).filter(i => i.endsWith('.js'))).toEqual([]);
  });

  it('NestJS 12 generates an ES module project', () => {
    const files = project(cfg({ frameworkVersion: '12' }));
    const p = pkg(files);
    expect(p.type).toBe('module');
    expect(p.dependencies['@nestjs/core']).toBe('^12.1.0');
    expect(p.dependencies['@nestjs/schedule']).toBe('^12.0.0');
    expect(p.scripts.start).toBe('node dist/src/main.js');
    expect(p.scripts.test).toContain('--experimental-vm-modules');
    expect(p.scripts.test).toContain('--import tsx');
    expect(files.get('jest.config.js')).toContain('export default');
    expect(files.get('jest.config.js')).toContain('useESM: true');
    expect(files.get('cucumber.js')).toContain("import: ['test/steps/**/*.ts']");
    const imports = relativeImports(files);
    expect(imports.length).toBeGreaterThan(5);
    expect(imports.filter(i => !i.endsWith('.js'))).toEqual([]);
  });

  it('Prisma 7 generates the new client, prisma.config.ts and the driver adapter for the database', () => {
    const pg = project(cfg({ ormVersion: '7' }));
    expect(pg.get('prisma/schema.prisma')).toMatch(/provider\s+= "prisma-client"[\s\S]*moduleFormat = "cjs"/);
    expect(pg.get('prisma/schema.prisma')).not.toContain('env("DATABASE_URL")');
    expect(pg.get('prisma.config.ts')).toContain("from 'prisma/config'");
    expect(pg.get('src/prisma/prisma.service.ts')).toContain("import { PrismaPg } from '@prisma/adapter-pg'");
    expect(pg.get('src/prisma/prisma.service.ts')).toContain("from '../generated/prisma/client'");
    expect(pg.get('src/prisma/prisma.service.ts')).toContain('super({ adapter: new PrismaPg(');
    expect([...pg.keys()].find(k => k.startsWith('src/persistence/'))).toBeDefined();
    expect(pg.get([...pg.keys()].find(k => k.startsWith('src/persistence/'))!)).toContain("from '../generated/prisma/client'");
    expect(pkg(pg).dependencies).toMatchObject({ '@prisma/client': '^7.10.0', '@prisma/adapter-pg': '^7.10.0' });

    const mysql = project(cfg({ ormVersion: '7', database: 'mysql' }));
    expect(pkg(mysql).dependencies['@prisma/adapter-mariadb']).toBe('^7.10.0');
    expect(mysql.get('src/prisma/prisma.service.ts')).toContain('new PrismaMariaDb(');

    const esm = project(cfg({ frameworkVersion: '12', ormVersion: '7' }));
    expect(esm.get('prisma/schema.prisma')).toContain('moduleFormat = "esm"');
    expect(esm.get('src/prisma/prisma.service.ts')).toContain("from '../generated/prisma/client.js'");
  });

  it('Express gets Prisma 7 dependencies and config but stays CommonJS', () => {
    const files = project(cfg({ framework: 'express', ormVersion: '7' }));
    expect(pkg(files).type).toBeUndefined();
    expect(pkg(files).devDependencies.prisma).toBe('^7.10.0');
    expect(files.has('prisma.config.ts')).toBe(true);
  });

  it('resolves the Prisma client import relative to the importing directory', () => {
    expect(prismaClientImport(resolveNodeProfile(cfg()), 'src/prisma')).toBe('@prisma/client');
    expect(prismaClientImport(resolveNodeProfile(cfg({ ormVersion: '7' })), 'src/persistence')).toBe('../generated/prisma/client');
    expect(prismaClientImport(resolveNodeProfile(cfg({ ormVersion: '7', frameworkVersion: '12' })), 'src')).toBe('./generated/prisma/client.js');
  });

  it('maps each combination to its stable, golden-verified support entry', () => {
    expect(getStackSupport(cfg()).id).toBe('typescript/nestjs');
    expect(getStackSupport(cfg({ frameworkVersion: '12', ormVersion: '7' })).id).toBe('typescript/nestjs-12');
    expect(getStackSupport(cfg({ frameworkVersion: '12' })).id).toBe('typescript/nestjs-12-prisma6');
    expect(getStackSupport(cfg({ ormVersion: '7' })).id).toBe('typescript/nestjs-prisma7');
    expect(getStackSupport(cfg({ framework: 'express', ormVersion: '7' })).id).toBe('typescript/express-prisma7');
    expect(getStackSupport(cfg({ frameworkVersion: '12', ormVersion: '7' })).tier).toBe('stable');
  });
});
