/* ==========================================================================
   gherkin-ai-cli - JSON Schema export for gherkin-ai.config.json
   (used by `ghk config schema` and the build to emit schemas/config.schema.json)
   ========================================================================== */

import { z } from 'zod';
import { partialConfigSchema } from './schema';
import { industryProfileSchema } from '../profiles/industries/types';

export const CONFIG_SCHEMA_ID = 'https://unpkg.com/gherkin-ai/schemas/config.schema.json';

/**
 * JSON Schema (draft-07, every definition inlined) of what a file may contain. Unknown keys are flagged
 * (editors underline them; the loader warns), and the root accepts the `$schema` reference that
 * `ghk upgrade` adds.
 */
const toJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    reused: 'inline',
    unrepresentable: 'any',
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === 'object' && jsonSchema.properties && jsonSchema.additionalProperties === undefined) jsonSchema.additionalProperties = false;
    }
  }) as Record<string, any>;
  const { $schema: _draft, ...rest } = json;
  rest.properties = { $schema: { type: 'string' }, ...rest.properties };
  return { $schema: 'http://json-schema.org/draft-07/schema#', ...rest };
};

export const INDUSTRY_CONTEXT_SCHEMA_ID = 'https://unpkg.com/gherkin-ai/schemas/industry-context.schema.json';

/** Schema of .ghe/industry-context.json (what `ghk industry show --json` and the MCP tool return). */
export function buildIndustryContextJsonSchema(): Record<string, unknown> {
  const context = industryProfileSchema.extend({
    lintRules: z.array(z.object({ id: z.string(), name: z.string(), severity: z.enum(['error', 'warning', 'info']) }))
  });
  const schema = toJsonSchema(context);
  return { $id: INDUSTRY_CONTEXT_SCHEMA_ID, title: 'gherkin-ai industry context', ...schema };
}

export function buildConfigJsonSchema(): Record<string, unknown> {
  // Each config file is a layer, so the published schema is the partial (all-optional) shape.
  const schema = toJsonSchema(partialConfigSchema);
  return { $id: CONFIG_SCHEMA_ID, title: 'gherkin-ai configuration', ...schema };
}
