import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface AppContext {
  dataModels: string[];
  domSelectors: string[];
}

export class ContextExtractor {
  public extract(workspaceRoot: string): AppContext {
    const context: AppContext = {
      dataModels: [],
      domSelectors: []
    };

    try {
      // 1. Prisma Schema (Data Models)
      const prismaPath = path.join(workspaceRoot, 'prisma', 'schema.prisma');
      if (fs.existsSync(prismaPath)) {
        const prismaContent = fs.readFileSync(prismaPath, 'utf8');
        const models = prismaContent.match(/model\s+(\w+)\s+{([^}]+)}/g) || [];
        // Keep it concise for prompt injection (limit 5 models)
        context.dataModels = models.slice(0, 5).map(m => m.substring(0, 300) + (m.length > 300 ? '...' : ''));
      }

      // 2. DOM Selectors (Playwright/Cypress Page Objects)
      const e2eDir = path.join(workspaceRoot, 'e2e');
      if (fs.existsSync(e2eDir)) {
        this.findSelectors(e2eDir, context.domSelectors);
      }
    } catch (e: any) {
      logger.error(`Context extraction error: ${e.message}`);
    }

    return context;
  }

  private findSelectors(dir: string, selectors: string[]) {
    if (selectors.length > 20) return; // limit
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        this.findSelectors(fullPath, selectors);
      } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        // Look for common selector patterns: data-testid, data-test
        const matches = [...content.matchAll(/data-test(?:id)?=['"]([^'"]+)['"]/g)];
        matches.forEach(m => {
          const val = m[1];
          if (!selectors.includes(val)) selectors.push(val);
        });
      }
    }
  }
}
