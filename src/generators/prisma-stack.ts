/* ==========================================================================
   gherkin-ai-cli - Prisma Stack Generator
   ========================================================================== */

import { featurePascalName } from '../utils/naming';
import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { prismaClientImport, renderPrismaConfig, renderPrismaHeader, resolveNodeProfile, withEsmImportExtensions } from './node-profile';

/** Tables used by the generated NestJS outbox, idempotency interceptor and saga orchestrator. */
const NEST_INFRASTRUCTURE_MODELS = `
model OutboxMessage {
  id          String    @id @default(uuid())
  eventType   String
  payload     String
  occurredOn  DateTime  @default(now())
  processedOn DateTime?
  retryCount  Int       @default(0)
  lastError   String?

  @@index([processedOn, occurredOn])
}

model ProcessedEvent {
  eventId      String   @id
  status       String
  responseBody String   @default("")
  processedAt  DateTime @default(now())

  @@index([status, processedAt])
}

model SagaInstance {
  id           String   @id
  sagaType     String
  entityId     String
  currentState String
  metadata     String?
  errorReason  String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
`;

export function generatePrismaStack(parsed: ParsedFeature, config: GherkinAIConfig): { filename: string; content: string }[] {
  if (config.stack.orm !== 'prisma') {
    return [];
  }

  const artifacts: { filename: string; content: string }[] = [];
  const modelName = featurePascalName(parsed);
  // Prisma client delegates are camelCase: model PaymentProcessing -> prisma.paymentProcessing
  const delegate = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const profile = resolveNodeProfile(config);
  const isNest = ['nestjs', 'nest'].includes((config.stack.framework || '').toLowerCase());

  let fieldsStr = `  id String @id @default(uuid())\n`;
  // PrismaService.tenant (a query extension) scopes every domain query by tenantId.
  if (isNest) fieldsStr += `  tenantId String @default("default")\n`;
  // Feature fields can repeat the columns declared above (or each other); Prisma rejects duplicates.
  const declared = new Set(['id', ...(isNest ? ['tenantid'] : [])]);
  parsed.domainAnalysis.fields.forEach(f => {
    if (!/^[A-Za-z]\w*$/.test(f.name) || declared.has(f.name.toLowerCase())) return;
    declared.add(f.name.toLowerCase());
    let type = f.type === 'number' ? 'Int' : 'String';
    if (f.name.toLowerCase().includes('date') || f.name.toLowerCase().includes('time')) {
      type = 'DateTime';
    } else if (f.name.toLowerCase().includes('is') || f.name.toLowerCase().includes('has')) {
      type = 'Boolean';
    }
    fieldsStr += `  ${f.name} ${type}\n`;
  });

  const schemaContent = `// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema

${renderPrismaHeader(profile)}
model ${modelName} {
${fieldsStr}
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
${isNest ? `
  @@index([tenantId])
` : ''}}
${isNest ? NEST_INFRASTRUCTURE_MODELS : ''}`;

  artifacts.push({
    filename: `prisma/schema.prisma`,
    content: schemaContent
  });
  if (profile.prisma === '7') artifacts.push({ filename: 'prisma.config.ts', content: renderPrismaConfig() });

  if (isNest) {
    const serviceContent = `import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ${modelName} } from '${prismaClientImport(profile, 'src/persistence')}';

@Injectable()
export class ${modelName}Repository {
  constructor(private prisma: PrismaService) {}

  async findById(id: string): Promise<${modelName} | null> {
    return this.prisma.tenant.${delegate}.findUnique({ where: { id } });
  }

  async save(data: Omit<${modelName}, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): Promise<${modelName}> {
    return this.prisma.tenant.${delegate}.create({
      data,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.tenant.${delegate}.delete({ where: { id } });
  }
}
`;
    artifacts.push({
      filename: `src/persistence/${modelName.toLowerCase()}.repository.ts`,
      content: profile.esm ? withEsmImportExtensions(serviceContent) : serviceContent
    });
  }

  return artifacts;
}
