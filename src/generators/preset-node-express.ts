/* ==========================================================================
   gherkin-ai-cli - Node Express (TypeScript) Preset Generator  [stable]

   Express 4 API on the shared TypeScript domain kernel: jest unit + supertest
   API tests, cucumber-js bound to ./features (pending, non-strict), Prisma
   schema when orm=prisma. Verified by scripts/golden-build.js (express).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel } from './kernel/domain-model';
import {
  renderCucumberJsConfig,
  renderCucumberJsSteps,
  renderJestConfig,
  renderTsAggregate,
  renderTsAggregateSpec,
  renderTsConfigs
} from './kernel/typescript';

export function generateNodeExpressPreset(parsed: ParsedFeature, _config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  const first = m.commands[0];
  const domain = `src/domain/${m.kebab}.aggregate`;

  const app = `import express, { NextFunction, Request, Response } from 'express';
import { ${m.pascal}Aggregate, ${m.pascal}Command, ${m.pascal}DomainEvent, DomainValidationError } from './domain/${m.kebab}.aggregate';

type Handler = (aggregate: ${m.pascal}Aggregate, command: ${m.pascal}Command) => ${m.pascal}DomainEvent;

const COMMANDS: Record<string, Handler> = {
${m.commands.map(c => `  ${c.snake}: (a, c) => a.${c.method}(c),`).join('\n')}
};

/** Builds the Express app. The in-memory store is a placeholder for a repository + outbox. */
export function createApp(): express.Express {
  const app = express();
  const store = new Map<string, ${m.pascal}Aggregate>();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/v1/${m.kebab}/:id/:command', (req: Request<{ id: string; command: string }>, res: Response, next: NextFunction) => {
    const handler = COMMANDS[req.params.command];
    if (!handler) {
      res.status(404).json({ detail: \`Unknown command \${req.params.command}\` });
      return;
    }
    try {
      const id = req.params.id;
      const aggregate = store.get(id) ?? new ${m.pascal}Aggregate(id);
      store.set(id, aggregate);
      const event = handler(aggregate, { id, payload: req.body ?? {} });
      res.status(201).json({ type: event.type, aggregateId: event.aggregateId, version: event.version });
    } catch (err) {
      if (err instanceof DomainValidationError) {
        res.status(422).json({ detail: err.message });
        return;
      }
      next(err);
    }
  });

  return app;
}
`;

  const server = `import { createApp } from './app';

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(\`listening on :\${port}\`);
});
`;

  const appSpec = `import request from 'supertest';
import { createApp } from './app';

describe('HTTP API', () => {
  const app = createApp();

  it('reports health', async () => {
    await request(app).get('/health').expect(200, { status: 'ok' });
  });

  it('executes a domain command and returns the event', async () => {
    const res = await request(app).post('/api/v1/${m.kebab}/agg-api/${first.snake}').send({ source: 'api-test' }).expect(201);
    expect(res.body).toEqual({ type: '${first.event}', aggregateId: 'agg-api', version: 1 });
  });

  it('returns 404 for unknown commands', async () => {
    await request(app).post('/api/v1/${m.kebab}/agg-api/does_not_exist').expect(404);
  });
});
`;

  return [
    { filename: `${domain}.ts`, content: renderTsAggregate(m) },
    { filename: `${domain}.spec.ts`, content: renderTsAggregateSpec(m, `./${m.kebab}.aggregate`) },
    { filename: 'src/app.ts', content: app },
    { filename: 'src/app.spec.ts', content: appSpec },
    { filename: 'src/server.ts', content: server },
    { filename: `test/steps/${m.kebab}.steps.ts`, content: renderCucumberJsSteps(m, `../../${domain}`) },
    { filename: 'cucumber.js', content: renderCucumberJsConfig('test/steps/**/*.ts') },
    { filename: 'jest.config.js', content: renderJestConfig(['<rootDir>/src']) },
    ...renderTsConfigs()
  ];
}
