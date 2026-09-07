/* ==========================================================================
   gherkin-ai-cli - Prisma Stack Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';

export function generatePrismaStack(parsed: ParsedFeature, config: GherkinAIConfig): { filename: string; content: string }[] {
  if (config.stack.orm !== 'prisma') {
    return [];
  }

  const artifacts: { filename: string; content: string }[] = [];
  const modelName = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '');

  let fieldsStr = `  id String @id @default(uuid())\n`;
  parsed.domainAnalysis.fields.forEach(f => {
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

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${config.stack.database === 'postgresql' ? 'postgresql' : (config.stack.database === 'mysql' ? 'mysql' : 'sqlite')}"
  url      = env("DATABASE_URL")
}

model ${modelName} {
${fieldsStr}
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`;

  artifacts.push({
    filename: `prisma/schema.prisma`,
    content: schemaContent
  });

  if (config.stack.framework === 'nestjs') {
    const serviceContent = `import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ${modelName} } from '@prisma/client';

@Injectable()
export class ${modelName}Repository {
  constructor(private prisma: PrismaService) {}

  async findById(id: string): Promise<${modelName} | null> {
    return this.prisma.${modelName.toLowerCase()}.findUnique({ where: { id } });
  }

  async save(data: Omit<${modelName}, 'id' | 'createdAt' | 'updatedAt'>): Promise<${modelName}> {
    return this.prisma.${modelName.toLowerCase()}.create({
      data,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.${modelName.toLowerCase()}.delete({ where: { id } });
  }
}
`;
    artifacts.push({
      filename: `src/persistence/${modelName.toLowerCase()}.repository.ts`,
      content: serviceContent
    });
  }

  return artifacts;
}
