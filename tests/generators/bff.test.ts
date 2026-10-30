/* ==========================================================================
   stack.role "bff" (PLAN-3.2.2 X-06; LMS limitations 19 and 24)

   A BFF is generated without the runtime kernel, database, outbox or events.
   The generated projects are built and their tests run against a stub
   upstream in the goldens express-bff, nestjs-bff, nestjs-12-bff, spring-bff.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { defaultConfig, GherkinAIConfig } from '../../src/core/config';
import { ConfigError } from '../../src/core/errors';
import { generatePresets } from '../../src/generators/presets';
import { bffUpstreams, featureUpstream, renderBffInfra } from '../../src/generators/bff/model';
import { CoreContractsPlugin, CoreFixturesPlugin, CoreInfraPlugin, CorePrismaPlugin } from '../../src/plugins/core-generators-plugin';

const FEATURE = `@upstream:enrollment
Feature: Course enrollment
  Scenario: A student requests enrollment
    Given a signed-in student
    When the student requests enrollment in the course
    Then the request is accepted
`;

const config = (stack: Partial<GherkinAIConfig['stack']>, extra: Partial<GherkinAIConfig> = {}): GherkinAIConfig => ({
  ...defaultConfig, projectName: 'web-bff', outputDir: './',
  stack: { ...defaultConfig.stack, orm: 'none', role: 'bff', ...stack },
  bff: { upstreams: { academic: {}, enrollment: { url: 'http://enrollment-service:8080' } } },
  ...extra
});

const names = (files: { filename: string }[]) => files.map(f => f.filename);

describe('BFF generation', () => {
  const parsed = parseGherkinText(FEATURE);

  it('Express: a gateway without kernel, database or outbox', () => {
    const files = generatePresets(parsed, config({ language: 'typescript', framework: 'express' }));
    expect(names(files)).toEqual(expect.arrayContaining(['package.json', 'src/app.ts', 'src/server.ts', 'src/upstream/upstream-client.ts', 'src/upstream/gateway.ts', 'src/routes/course-enrollment.route.ts', 'src/app.spec.ts', 'Dockerfile']));
    expect(names(files).some(f => /runtime|domain|prisma|migrat/.test(f))).toBe(false);
    const route = files.find(f => f.filename === 'src/routes/course-enrollment.route.ts')!.content;
    expect(route).toContain("upstream: 'enrollment'");
    expect(route).toContain("commands: ['request_enrollment']");
    const pkg = JSON.parse(files.find(f => f.filename === 'package.json')!.content);
    expect(Object.keys(pkg.dependencies)).toEqual(['express', 'zod']);
    const client = files.find(f => f.filename === 'src/upstream/upstream-client.ts')!.content;
    expect(client).toContain("'enrollment': new UpstreamClient('enrollment', env.ENROLLMENT_URL ?? 'http://enrollment-service:8080')");
  });

  it('NestJS 12: ES modules with .js import specifiers', () => {
    const files = generatePresets(parsed, config({ language: 'typescript', framework: 'nestjs', frameworkVersion: '12' }));
    expect(JSON.parse(files.find(f => f.filename === 'package.json')!.content).type).toBe('module');
    expect(files.find(f => f.filename === 'src/app.module.ts')!.content).toContain("from './routes/course-enrollment.controller.js'");
    expect(files.find(f => f.filename === 'src/routes/course-enrollment.controller.ts')!.content).toContain("@Controller('bff/v1/course-enrollment')");
  });

  it('Spring Boot: controller, java.net.http client and a pom without JPA, JDBC or AMQP', () => {
    const files = generatePresets(parsed, config({ language: 'java', framework: 'spring-boot' }));
    const pom = files.find(f => f.filename === 'pom.xml')!.content;
    expect(pom).toContain('spring-boot-starter-webmvc');
    expect(pom).not.toMatch(/data-jpa|postgresql|amqp-client/);
    expect(names(files)).toEqual(expect.arrayContaining([
      'src/main/java/com/example/webbff/api/CourseEnrollmentBffController.java',
      'src/main/java/com/example/webbff/upstream/UpstreamClient.java',
      'src/test/java/com/example/webbff/api/CourseEnrollmentBffControllerTest.java'
    ]));
    expect(names(files).some(f => /\/runtime\/|\/domain\//.test(f))).toBe(false);
  });

  it('other stacks are refused with a hint, not generated as a service', () => {
    expect(() => generatePresets(parsed, config({ language: 'python', framework: 'fastapi' }))).toThrow(ConfigError);
  });

  it('an @upstream tag that is not declared is a configuration error', () => {
    expect(() => featureUpstream(parseGherkinText('@upstream:billing\nFeature: X\n  Scenario: S\n    When it runs\n    Then ok\n'), config({}))).toThrow(/bff.upstreams/);
  });

  it('without bff.upstreams there is one "backend" upstream at BACKEND_URL', () => {
    expect(bffUpstreams({})).toEqual([{ name: 'backend', envVar: 'BACKEND_URL', url: 'http://backend:8080' }]);
  });
});

describe('BFF contracts and infrastructure', () => {
  const parsed = parseGherkinText(FEATURE);
  const ir = buildIR(parsed, 'features/course_enrollment.feature');
  const cfg = config({ language: 'typescript', framework: 'express', orm: 'prisma' });

  it('serves /bff/v1 routes, publishes no events and leaves the build file to the BFF preset', () => {
    const artifacts = new CoreContractsPlugin().generate(ir, cfg);
    const openapi = JSON.parse(artifacts.find(a => a.filePath === 'openapi.json')!.content);
    expect(Object.keys(openapi.paths).every(p => p.startsWith('/bff/v1/'))).toBe(true);
    expect(artifacts.some(a => a.filePath.endsWith('asyncapi.json'))).toBe(false);
    expect(artifacts.some(a => a.filePath === 'package.json')).toBe(false);
  });

  it('has no seed, no Prisma schema, and a compose file with only the BFF and its upstream URLs', () => {
    expect(new CoreFixturesPlugin().generate(ir, cfg).map(a => a.filePath)).toEqual(['fixtures.ts']);
    expect(new CorePrismaPlugin().generate(ir, cfg)).toEqual([]);
    const infra = new CoreInfraPlugin().generate(ir, cfg);
    expect(infra.map(a => a.filePath)).toEqual(['docker-compose.yml', '.env.example']);
    const compose = infra[0].content;
    expect(compose).toContain('ENROLLMENT_URL: ${ENROLLMENT_URL:-http://enrollment-service:8080}');
    expect(compose).not.toMatch(/postgres|rabbitmq/i);
    expect(renderBffInfra(cfg).env).toContain('ACADEMIC_URL=http://academic:8080');
  });
});
