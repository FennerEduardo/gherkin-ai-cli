import { describe, it, expect } from 'vitest';
import { generateNestJsMultiTenancyInfrastructure } from '../../src/generators/nestjs/multitenancy-generator';

const service = generateNestJsMultiTenancyInfrastructure().find(f => f.filename === 'src/prisma/prisma.service.ts')!.content;

describe('NestJS PrismaService tenant scope', () => {
  it('uses a client extension (Prisma 6.14 removed $use)', () => {
    expect(service).toContain('$extends(');
    expect(service).not.toContain('$use(');
    expect(service).toContain('readonly tenant = withTenantScope(this)');
  });

  it('does not compare against operations that only exist for some database providers', () => {
    // MySQL has no createManyAndReturn: a literal comparison fails to type-check there (TS2367).
    expect(service).not.toMatch(/operation\s*===\s*'(createMany|createManyAndReturn|updateManyAndReturn)'/);
  });
});
