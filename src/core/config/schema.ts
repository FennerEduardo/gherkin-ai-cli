/* ==========================================================================
   gherkin-ai-cli - Configuration Schema (zod)

   The schema is the single source of truth for `gherkin-ai.config.json`,
   the user config (~/.gherkin-ai/config.json) and the organization config
   (GHK_ORG_CONFIG). Every layer is validated against `partialConfigSchema`;
   the merged result is validated against `configSchema`.
   ========================================================================== */

import { z } from 'zod';

export const ARCHITECTURES = [
  'ddd', 'hexagonal', 'clean', 'cqrs', 'microservices', 'monolith', 'modular',
  'api-rest', 'serverless', 'event-driven', 'monorepo-workspaces', 'desktop'
] as const;

export const LLM_PROVIDERS = [
  'openai', 'openai-compatible', 'azure-openai', 'anthropic', 'bedrock', 'gemini', 'vertex', 'ollama', 'ide_delegate'
] as const;

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'verbose', 'debug'] as const;

const stackSchema = z.object({
  language: z.string(),
  framework: z.string(),
  /** Major version of the framework to generate for (NestJS: "11" default, "12"). */
  frameworkVersion: z.string().optional().describe('Framework major to generate for. NestJS: "11" (default, CommonJS) or "12" (ES modules).'),
  orm: z.string(),
  /** Major version of the ORM (Prisma: "6" default, "7"). */
  ormVersion: z.string().optional().describe('ORM major to generate for. Prisma: "6" (default) or "7" (prisma-client generator, prisma.config.ts, driver adapter).'),
  database: z.string(),
  validation: z.string(),
  auth: z.string(),
  messaging: z.string().optional(),
  testing: z.string(),
  aiEngine: z.string().optional()
});

const frontendStackSchema = z.object({
  framework: z.string(),
  language: z.string(),
  bundler: z.string().optional(),
  stateManagement: z.string().optional(),
  orm: z.string().optional(),
  database: z.string().optional(),
  validation: z.string().optional(),
  testing: z.string().optional(),
  unitTesting: z.string().optional(),
  e2eTesting: z.string().optional()
});

const rulesSchema = z.object({
  bcryptCostFactor: z.number().int().min(4).max(31).optional(),
  jwtTtlSeconds: z.number().int().positive().optional(),
  strictLayerBoundaries: z.boolean().optional(),
  coverageTarget: z.number().min(0).max(100).optional()
});

const auditSchema = z.object({
  enabled: z.boolean().optional(),
  maxEntries: z.number().int().positive().optional(),
  persistInGit: z.boolean().optional()
});

export const llmSchema = z.object({
  provider: z.enum(LLM_PROVIDERS).optional(),
  model: z.string().optional(),
  /** Base URL for OpenAI-compatible gateways (LiteLLM, internal proxies) or a custom Ollama host. */
  baseUrl: z.string().url().optional(),
  /** Extra HTTP headers sent to the provider (e.g. gateway routing or cost-center headers). */
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  azure: z.object({
    endpoint: z.string().url().optional(),
    deployment: z.string().optional(),
    apiVersion: z.string().optional(),
    /** Use Microsoft Entra ID (DefaultAzureCredential) instead of an API key. */
    useEntraId: z.boolean().optional()
  }).optional(),
  bedrock: z.object({
    region: z.string().optional()
  }).optional(),
  vertex: z.object({
    project: z.string().optional(),
    location: z.string().optional()
  }).optional(),
  budget: z.object({
    maxTokensPerRun: z.number().int().positive().optional()
  }).optional(),
  /** Organization allow-lists. Empty or absent means "no restriction". */
  allowedProviders: z.array(z.enum(LLM_PROVIDERS)).optional(),
  allowedModels: z.array(z.string()).optional(),
  allowedBaseUrls: z.array(z.string()).optional()
});

const mcpSchema = z.object({
  /** Allow MCP tools that write files or run commands. Default: false (read-only). */
  allowWrite: z.boolean().optional()
});

const networkSchema = z.object({
  /** Explicit proxy URL. When absent, HTTPS_PROXY / HTTP_PROXY / NO_PROXY are honored. */
  proxy: z.string().url().optional(),
  noProxy: z.string().optional(),
  /** PEM bundle with additional trusted CAs (corporate TLS inspection). */
  caFile: z.string().optional()
});

const loggingSchema = z.object({
  level: z.enum(LOG_LEVELS).optional(),
  /** Optional log file. When absent, nothing is written to disk. */
  file: z.string().optional(),
  maxSizeMb: z.number().positive().optional(),
  maxFiles: z.number().int().positive().optional()
});

const telemetrySchema = z.object({
  /** Local-only JSONL telemetry and audit events. Nothing is ever sent remotely. */
  enabled: z.boolean().optional(),
  dir: z.string().optional()
});

const pluginsSchema = z.preprocess(
  // 2.x accepted a bare array of module names; treat it as `load`.
  value => (Array.isArray(value) ? { load: value } : value),
  z.object({
    /** Plugins to load: npm package names or paths relative to the project. */
    load: z.array(z.string()).optional(),
    /** Organization allow-list. When set, only these specifiers may be loaded. */
    allow: z.array(z.string()).optional()
  })
);

const sandboxSchema = z.object({
  /** Docker network for `verify --docker`. "none" (default) blocks network access; use "bridge" when tests download dependencies. */
  network: z.string().optional(),
  /** Container memory limit (docker --memory). Default "2g". */
  memory: z.string().optional(),
  /** Container CPU limit (docker --cpus). Default "2". */
  cpus: z.string().optional(),
  /** Maximum processes in the container (docker --pids-limit). Default 512. */
  pidsLimit: z.number().int().positive().optional(),
  /** Overrides the toolchain image for the stack. */
  image: z.string().optional()
});

const infrastructureSchema = z.object({
  /** Generate the AWS CDK app in ./infrastructure (TypeScript, verified with `cdk synth`). Default: false. */
  awsCdk: z.boolean().optional()
});

const policySchema = z.object({
  /** Allow --apply / --auto-fix / autopilot writes when running in CI. Default: false. */
  allowUnattendedWrites: z.boolean().optional(),
  /** Branches on which agent-driven writes are refused unless --force-branch is passed. */
  protectedBranches: z.array(z.string()).optional(),
  /** Also redact PII (emails, card numbers, SSNs, IPs) from prompts. Secrets are always redacted. */
  redactPii: z.boolean().optional()
});

export const configShape = {
  /** Optional file format marker found in older configs; informational only. */
  version: z.string().optional(),
  projectName: z.string().min(1),
  projectMode: z.enum(['greenfield', 'brownfield', 'monorepo']).optional(),
  architecture: z.enum(ARCHITECTURES),
  stack: stackSchema,
  frontendStack: frontendStackSchema.optional(),
  rules: rulesSchema,
  audit: auditSchema.optional(),
  designPatterns: z.array(z.string()).optional(),
  codingRules: z.array(z.string()).optional(),
  outputDir: z.string(),
  specDir: z.string().optional(),
  testCommand: z.string().optional(),
  domainProfile: z.string().optional(),
  channelMapping: z.record(z.string()).optional(),
  locale: z.enum(['en', 'es']).optional(),
  llm: llmSchema.optional(),
  mcp: mcpSchema.optional(),
  network: networkSchema.optional(),
  logging: loggingSchema.optional(),
  telemetry: telemetrySchema.optional(),
  plugins: pluginsSchema.optional(),
  policy: policySchema.optional(),
  sandbox: sandboxSchema.optional(),
  infrastructure: infrastructureSchema.optional(),
  /** Extra API contract formats generated next to OpenAPI/AsyncAPI. */
  contracts: z.object({
    grpc: z.boolean().optional(),
    graphql: z.boolean().optional()
  }).optional(),
  /**
   * Dot-paths that lower-precedence layers may not override (e.g. "llm.allowedProviders").
   * Only honored when declared in the organization config.
   */
  locked: z.array(z.string()).optional()
};

export const configSchema = z.object(configShape);

/** Schema for a single layer: every field optional, nested objects partial. */
export const partialConfigSchema = z.object({
  ...configShape,
  projectName: configShape.projectName.optional(),
  architecture: configShape.architecture.optional(),
  stack: stackSchema.partial().optional(),
  frontendStack: frontendStackSchema.partial().optional(),
  rules: rulesSchema.optional(),
  outputDir: configShape.outputDir.optional()
});

export type GherkinAIConfig = z.infer<typeof configSchema>;
export type PartialGherkinAIConfig = z.infer<typeof partialConfigSchema>;
export type LLMSettings = z.infer<typeof llmSchema>;
export type LLMProviderName = (typeof LLM_PROVIDERS)[number];
