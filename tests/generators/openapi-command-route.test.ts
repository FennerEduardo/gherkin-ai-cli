import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { defaultConfig } from '../../src/core/config';
import { generateContracts } from '../../src/generators/contracts';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';
import { commandRoute } from '../../src/generators/kernel/app/shared';
import { validateOpenAPIAgainstIR, validateOpenAPISpec } from '../../src/core/openapi-validator';

const FEATURE = [
  '# language: es',
  '@aggregate:PaymentExecution',
  'Característica: Ejecución de pagos',
  '  Escenario: Pago aceptado',
  '    Dado una orden de pago por 120 COP',
  '    Cuando el Debtor ejecuta el pago',
  '    Entonces el pago queda aceptado con HTTP 201',
  '    Y se publica un evento PaymentExecuted'
].join('\n');

describe('OpenAPI contract of the generated command route', () => {
  const parsed = parseGherkinText(FEATURE);
  const ir = buildIR(parsed, 'pay.feature');
  const config = { ...defaultConfig, projectName: 'svc' };
  const openapi = JSON.parse(generateContracts(parsed, ir, config).openApiJson);
  const m = buildDomainModel(parsed, { service: 'svc' });

  it('describes exactly the route the application layer serves', () => {
    expect(Object.keys(openapi.paths)).toEqual([`${commandRoute(m)}/{id}/{command}`]);
    const op = openapi.paths[`${commandRoute(m)}/{id}/{command}`].post;
    const command = op.parameters.find((p: any) => p.name === 'command');
    expect(command.schema.enum).toEqual(m.commands.map(c => c.snake));
    expect(op.parameters.map((p: any) => p.name)).toEqual(['id', 'command', 'Idempotency-Key', 'traceparent']);
    expect(op.security).toEqual([{ bearerAuth: [] }]);
  });

  it('documents the route responses, not codes the route never returns', () => {
    const op = openapi.paths[`${commandRoute(m)}/{id}/{command}`].post;
    expect(Object.keys(op.responses).sort()).toEqual(['200', '202', '401', '409', '422']);
    expect(op.responses['202'].content['application/json'].schema.$ref).toBe('#/components/schemas/CommandResult');
    expect(op.responses['422'].content['application/json'].schema.$ref).toBe('#/components/schemas/Error');
    expect(openapi.components.schemas.Error.required).toEqual(['detail']);
  });

  it('passes the CLI validators', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-oas-')), 'openapi.json');
    fs.writeFileSync(file, JSON.stringify(openapi));
    expect(validateOpenAPISpec(file).errors).toEqual([]);
    expect(validateOpenAPIAgainstIR(file, ir).errors).toEqual([]);
  });
});
