import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePrismaStack } from '../../src/generators/prisma-stack';

describe('Prisma schema', () => {
  it('never redeclares id/tenantId or repeats a field extracted from the feature', () => {
    const parsed = parseGherkinText([
      '# language: es',
      'Característica: Pedido con token',
      '  Escenario: Crear',
      '    Dado un usuario autenticado con ID "usr-sec-01"',
      '    Y un tenantId "acme" y un email "a@b.co"',
      '    Cuando envía un email "c@d.co"',
      '    Entonces el pedido queda registrado'
    ].join('\n'));
    const config = { ...defaultConfig, stack: { ...defaultConfig.stack, framework: 'nestjs', orm: 'prisma' } };
    const schema = generatePrismaStack(parsed, config).find((a: any) => a.filename.endsWith('schema.prisma'))!.content;
    const model = schema.slice(schema.indexOf('model PedidoConToken'));
    const columns = [...model.split('}')[0].matchAll(/^\s+(\w+)\s+\w+/gm)].map(m => m[1].toLowerCase());
    expect(columns).toContain('id');
    expect(columns).toContain('email');
    expect(new Set(columns).size).toBe(columns.length);
  });
});
