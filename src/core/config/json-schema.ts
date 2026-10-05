/* ==========================================================================
   gherkin-ai-cli - JSON Schema export for gherkin-ai.config.json
   (used by `ghk config schema` and the build to emit schemas/config.schema.json)
   ========================================================================== */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { partialConfigSchema } from './schema';

export const CONFIG_SCHEMA_ID = 'https://unpkg.com/gherkin-ai/schemas/config.schema.json';

// zod-to-json-schema's overloaded generics hit TS2589 on a schema this size; call it untyped.
const toJsonSchema = zodToJsonSchema as unknown as (schema: unknown, options: Record<string, unknown>) => Record<string, unknown>;

export function buildConfigJsonSchema(): Record<string, unknown> {
  // Each config file is a layer, so the published schema is the partial (all-optional) shape.
  const schema = toJsonSchema(partialConfigSchema, { name: 'GherkinAIConfig', $refStrategy: 'none' });
  return { $id: CONFIG_SCHEMA_ID, title: 'gherkin-ai configuration', ...schema };
}
