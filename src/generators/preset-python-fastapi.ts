/* ==========================================================================
   gherkin-ai-cli - Python FastAPI & pytest-bdd Preset Generator  [stable]

   Installable project (pyproject.toml): domain kernel + pytest, a FastAPI
   API executing the kernel commands (TestClient tests), pytest-bdd bound to
   the feature (pending steps skip), SQLAlchemy patterns (outbox, saga,
   idempotency, multitenancy) and an import smoke test for every module.
   Verified by scripts/golden-build.js (fastapi).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toKebab } from './kernel/domain-model';
import { renderFastApiHttpIntegration, renderFastApiMain, renderFastApiUnitTest, renderPyAuth, renderPyWorker } from './kernel/app/python';
import { tenantClaim } from './kernel/app/shared';
import { PyFile, pyModulesOf, renderPyImportSmokeTest, renderPyKernel, renderPyKernelTests, renderPytestBdd, withInitFiles } from './kernel/python';
import { PY_INTEGRATION_MARKER, PY_RUNTIME_DEPENDENCIES, renderPyRuntime } from './kernel/runtime/python';
import { PY_DATABASE, PY_EVENT_BUS, pyEventBusTest, pyFeatureFile, renderPyproject } from './python/python-common';

export function generatePythonFastApiPreset(parsed: ParsedFeature, config?: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);

  const runtime = renderPyRuntime(m);
  const appFiles: PyFile[] = withInitFiles([
    { filename: 'app/database.py', content: PY_DATABASE },
    { filename: 'app/infrastructure/event_bus.py', content: PY_EVENT_BUS },
    ...renderPyKernel(m),
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified by tests/integration (docs/RUNTIME-KERNEL.md).
    ...runtime.filter(f => f.filename.startsWith('app/')),
    // Application layer wired to the kernel (kernel/app/shared.ts): HTTP commands, JWT tenant, relay worker.
    { filename: 'app/main.py', content: renderFastApiMain(m) },
    { filename: 'app/auth.py', content: renderPyAuth(tenantClaim(config)) },
    { filename: 'app/worker.py', content: renderPyWorker(m) }
  ]);

  return [
    ...appFiles,
    ...renderPyKernelTests(m),
    ...runtime.filter(f => f.filename.startsWith('tests/')),
    ...renderPytestBdd(m, pyFeatureFile(m, featureFile)),
    pyEventBusTest(),
    { filename: 'tests/test_api.py', content: renderFastApiUnitTest(m) },
    { filename: 'tests/integration/test_http.py', content: renderFastApiHttpIntegration(m) },
    renderPyImportSmokeTest(pyModulesOf(appFiles.map(f => f.filename))),
    {
      filename: 'pyproject.toml',
      content: renderPyproject(
        toKebab(config?.projectName || m.kebab),
        ['fastapi>=0.115', 'uvicorn>=0.30', 'sqlalchemy>=2.0', 'pydantic>=2.7', ...PY_RUNTIME_DEPENDENCIES],
        ['pytest>=8.3', 'pytest-bdd>=7.3', 'httpx>=0.27'],
        [PY_INTEGRATION_MARKER]
      )
    }
  ];
}
