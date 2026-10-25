/* ==========================================================================
   gherkin-ai-cli - What a generated file is for

   `ghk generate` writes four kinds of files. In a project marked as
   implemented they are treated differently (core/write-protection.ts):
   - kernel:   the runtime kernel and the domain model it is built on. Created
               and refreshed as a unit: a kernel that is half new does not compile.
   - wiring:   binds the kernel into the framework (DataSource, relay worker,
               service provider). An implemented service has its own: never
               created there, or the service would get a second DataSource.
   - contract: OpenAPI, AsyncAPI, gRPC, GraphQL and per-feature contracts.
   - scaffold: everything else (controllers, step definitions, DTOs, config).
   The roles come from the paths the generators emit; tests/core/artifact-roles
   checks them against every stack.
   ========================================================================== */

export type ArtifactRole = 'kernel' | 'wiring' | 'contract' | 'scaffold';

const posix = (p: string) => p.replace(/\\/g, '/');

/** Runtime kernel files in every stack: a `runtime` directory or module, and the runtime integration test. */
export function isKernelFile(filePath: string): boolean {
  const p = posix(filePath);
  return /(^|\/)runtime\//i.test(p) || /(^|\/)[^/]*runtime[_.-]?(int|integration)[^/]*$/i.test(p) || /RuntimeIntegration(Test|Tests|Spec)?\.\w+$/.test(p);
}

/** Domain model the kernel is built on (aggregate, commands, events, state), and its tests. */
export function isDomainModelFile(filePath: string): boolean {
  return /(^|\/)domain\//i.test(posix(filePath));
}

const WIRING = [
  /(^|\/)(RuntimeConfiguration|RuntimeProducers|OutboxRelayWorker|DatabaseUrlConfigSource|RuntimeServiceProvider|OutboxRelayCommand|RuntimeCommandPort)\.\w+$/,
  /(^|\/)outbox_relay_worker\.ex$/,
  /(^|\/)runtime\/runtime\.module\.ts$/,
  /(^|\/)lib\/tasks\/outbox\.rake$/,
  /(^|\/)META-INF\/services\/org\.eclipse\.microprofile\.config\.spi\.ConfigSource$/,
  // Tests of the generated HTTP application layer, kept next to the kernel in some stacks.
  /(^|\/)[^/]*http_integration[^/]*$/i
];

const CONTRACT = [
  /(^|\/)contracts\//i,
  /(^|\/)(openapi|asyncapi)\.(json|ya?ml)$/i,
  /\.(proto|graphql)$/i
];

export function artifactRole(filePath: string, type?: string): ArtifactRole {
  const p = posix(filePath);
  if (WIRING.some(re => re.test(p))) return 'wiring';
  if (isKernelFile(p) || isDomainModelFile(p)) return 'kernel';
  if (type === 'contract' || type === 'openapi' || CONTRACT.some(re => re.test(p))) return 'contract';
  return 'scaffold';
}

/** Files a compiler or interpreter loads: the ones a kernel pending merge can break. */
export function isSourceCode(filePath: string): boolean {
  return /\.(java|kt|kts|scala|groovy|cs|fs|go|rs|py|rb|ex|exs|php|ts|tsx|mts|cts|js|jsx|mjs|cjs|dart|swift)$/i.test(posix(filePath));
}
