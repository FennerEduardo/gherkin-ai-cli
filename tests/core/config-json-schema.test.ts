import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { buildConfigJsonSchema, buildIndustryContextJsonSchema, CONFIG_SCHEMA_ID } from '../../src/core/config/json-schema';

describe('published JSON schemas', () => {
  const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(buildConfigJsonSchema());

  it('accepts a config with the $schema reference that ghk upgrade adds', () => {
    expect(validate({ $schema: CONFIG_SCHEMA_ID, projectName: 'orders', stack: { language: 'java', framework: 'spring-boot' }, generation: { exclude: ['src/main/resources/application.properties'] } }), JSON.stringify(validate.errors)).toBe(true);
  });

  it('flags unknown keys and wrong types, at the root and nested', () => {
    expect(validate({ unknownKey: true })).toBe(false);
    expect(validate({ stack: { language: 'java', cache: 'redis' } })).toBe(false);
    expect(validate({ generation: { protect: 'src/**' } })).toBe(false);
    expect(validate({ llm: { headers: { 'x-team': 1 } } })).toBe(false);
  });

  it('is draft-07 with every definition inlined', () => {
    const schema = buildConfigJsonSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(new Ajv({ strict: false }).compile(buildIndustryContextJsonSchema())).toBeTypeOf('function');
  });
});
