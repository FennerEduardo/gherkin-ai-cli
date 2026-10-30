/* ==========================================================================
   gherkin-ai-cli - Architectural Linter & 'validate' Command Handler
   ========================================================================== */

import { ExitCode } from '../core/errors';
import path from 'path';
import fs from 'fs';
import { loadConfig } from '../core/config';
import { getArchRule } from '../core/arch-rules';
import { parseGherkinText } from '../core/gherkin-parser';
import { fileExistsSync, readFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';
import { Project } from 'ts-morph';
import { validateOpenAPIAgainstIR, validateOpenAPISpec } from '../core/openapi-validator';
import { validateAsyncAPIAgainstIR, validateAsyncAPISpec } from '../core/asyncapi-validator';
import { runAllValidators, ValidatorContext } from '../core/validators/index';
import { validateDeploymentReadiness } from '../core/validators/deployment-readiness';
import { buildIR } from '../core/ir-builder';
import { StepIndexer } from '../core/step-indexer';
import { undefinedSteps } from '../core/step-coverage';
import { resolveFeatureFile } from '../core/workspace-projects';

/** Dependencies and build output are not the project's code. */
export const VALIDATE_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.git', 'bin', 'obj', 'coverage', '.gradle', '_build', 'deps', 'vendor', '.venv', '__pycache__', '.next', '.dart_tool']);

const CORE_LAYER_DIRS = new Set(['domain', 'model', 'core', 'application', 'usecases', 'use-cases', 'usecase']);
const EDGE_LAYER_DIRS = new Set(['infrastructure', 'infra', 'adapters', 'adapter', 'persistence', 'presentation', 'controllers', 'controller', 'api', 'http', 'web', 'runtime', 'modules']);

/**
 * Only domain and application code must stay free of frameworks and drivers. Infrastructure, adapters,
 * controllers, Nest modules and the entry point are where those imports belong.
 */
export function isCoreLayerFile(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, '/').toLowerCase().split('/');
  const name = segments.pop() ?? '';
  if (/^main\.|\.module\.|\.controller\.|\.repository\.|\.adapter\.|\.gateway\./.test(name)) return false;
  if (segments.some(s => EDGE_LAYER_DIRS.has(s))) return false;
  return segments.some(s => CORE_LAYER_DIRS.has(s));
}

/** The AsyncAPI document of this feature (contracts/<feature>/asyncapi.*), else the root one, else any. */
export function pickAsyncApiFile(files: string[], root: string, featureFile?: string): string | undefined {
  const specs = files.filter(f => /asyncapi[^/\\]*\.(json|ya?ml)$/i.test(path.basename(f)));
  const slug = featureFile ? path.basename(featureFile).replace(/\.feature$/i, '').toLowerCase() : '';
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    (slug ? specs.find(f => path.relative(root, f).split(/[\\/]/).slice(0, -1).some(seg => norm(seg) === norm(slug))) : undefined) ??
    specs.find(f => path.dirname(f) === root) ??
    specs[0]
  );
}

function collectFilesRecursively(dir: string): { path: string; content: string }[] {
  const results: { path: string; content: string }[] = [];
  if (!fs.existsSync(dir)) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (VALIDATE_SKIP_DIRS.has(entry.name)) continue;
        results.push(...collectFilesRecursively(fullPath));
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          results.push({ path: fullPath, content });
        } catch {
          // Ignore binary or unreadable files
        }
      }
    }
  } catch {
    // Ignore invalid directories
  }

  return results;
}

export async function handleValidateCommand(options: { feature?: string; config?: string; openapi?: string; asyncapi?: string; target?: string; strictSteps?: boolean }): Promise<void> {
  logger.banner();
  logger.info('Validating project architecture, step coverage & layer boundaries...');

  const config = loadConfig(options.config);
  const arch = getArchRule(config.architecture);

  logger.info(`Architecture Rule Target: ${arch.name} (${arch.id})`);
  const stackParts = [config.stack.language, config.stack.framework, config.stack.orm].filter(p => p && p !== 'none');
  logger.info(`Stack: ${stackParts.join(' + ')}${config.projectMode === 'brownfield' && !fs.existsSync(path.join(process.cwd(), options.config ?? 'gherkin-ai.config.json')) ? ' (detected: no gherkin-ai.config.json)' : ''}`);

  let errorsCount = 0;
  let warningsCount = 0;
  let parsedFeatureIR: any = null;

  // 1. Gherkin AST & Step Coverage Analysis
  if (options.feature) {
    const featurePath = resolveFeatureFile(options.feature);
    {
      const gherkinText = readFileSync(featurePath);
      const parsed = parseGherkinText(gherkinText);
      parsedFeatureIR = buildIR(parsed, featurePath, { domainProfile: config.domainProfile, industry: config.industry?.id });
      
      if (parsed.scenarios.length === 0) {
        logger.error('Feature file contains zero valid scenarios.');
        errorsCount++;
      } else {
        logger.success(`Gherkin Spec: Found ${parsed.scenarios.length} scenario(s).`);
        logger.info(`Domain Elements Extracted: ${parsed.domainAnalysis.commands.length} Command(s), ${parsed.domainAnalysis.queries.length} Query(ies), ${parsed.domainAnalysis.events.length} Event(s).`);

        // Check if all Given steps have corresponding fixture entries
        if (parsed.domainAnalysis.fixtures.length === 0) {
          logger.warn('No "Given" preconditions detected. Test seeds will be empty.');
          warningsCount++;
        }

        // Steps no step definition implements (they fail as "undefined" at run time). Generated pending
        // skeletons count as definitions.
        const steps = [...(parsed.background ? [parsed.background] : []), ...parsed.scenarios].flatMap(s => s.steps);
        const missing = undefinedSteps(steps, new StepIndexer().getAllSteps(process.cwd()));
        if (missing === undefined) {
          logger.info('Step coverage: no step definitions found in the project (not checked).');
        } else if (missing.length === 0) {
          logger.success('Step coverage: every step has a step definition.');
        } else {
          const log = options.strictSteps ? logger.error.bind(logger) : logger.warn.bind(logger);
          log(`Step coverage: ${missing.length} step(s) match no step definition${options.strictSteps ? '' : ' (--strict-steps fails on them)'}:`);
          for (const step of missing.slice(0, 20)) log(`  - ${step}`);
          if (options.strictSteps) errorsCount += missing.length; else warningsCount += missing.length;
        }
      }
    }
  }

  // 2. Contracts & Layer Boundary Verification via AST (ts-morph) for TypeScript/JS
  const tsProject = new Project();
  const targetForGlob = options.target || config.outputDir;
  const globRoot = targetForGlob.replace(/\\/g, '/');
  const outputDirGlob = path.posix.join(globRoot, '**/*.ts');
  const sourceFiles = tsProject.addSourceFilesAtPaths([
    outputDirGlob,
    ...[...VALIDATE_SKIP_DIRS].map(d => `!${path.posix.join(globRoot, `**/${d}/**`)}`)
  ]);
  const coreFiles = sourceFiles.filter(f => isCoreLayerFile(path.relative(path.resolve(process.cwd(), targetForGlob), f.getFilePath())));

  if (sourceFiles.length > 0) {
    let prohibitedFound = false;

    for (const sourceFile of coreFiles) {
      const imports = sourceFile.getImportDeclarations();
      for (const importDecl of imports) {
        try {
          if (!importDecl.getModuleSpecifier()) continue;
          const moduleSpecifier = importDecl.getModuleSpecifierValue();
          if (!moduleSpecifier) continue;
          arch.prohibitedImports.forEach(imp => {
            if (moduleSpecifier === imp || moduleSpecifier.startsWith(`${imp}/`)) {
              logger.error(`Layer Boundary Violation: ${path.relative(process.cwd(), sourceFile.getFilePath())} imports prohibited library "${imp}"`);
              errorsCount++;
              prohibitedFound = true;
            }
          });
        } catch {
          // Ignore non-string literal specifiers safely
        }
      }
    }

    if (!prohibitedFound) {
      logger.success(`Layer Boundary Check: ${coreFiles.length} domain/application file(s) of ${sourceFiles.length} TypeScript file(s) checked via AST. Core cleanly isolates domain from ${arch.prohibitedImports.join(', ')}.`);
    }
  }

  // 3. Multi-Language Distributed Systems Validators (.cs, .java, .ts, .py, .php, .json)
  const outputDirResolved = path.resolve(process.cwd(), options.target || config.outputDir);
  const allScannedFiles = collectFilesRecursively(outputDirResolved);

  if (allScannedFiles.length > 0) {
    // Pass any true boolean keys or string keys from rules as enabled rule strings
    const rulesRecord = config.rules as Record<string, any>;
    const enabledRules = Object.keys(config.rules).filter(k => rulesRecord[k] === true || typeof rulesRecord[k] === 'string');
    if (config.domainProfile) {
      enabledRules.push(config.domainProfile.toLowerCase());
    }

    const valContext: ValidatorContext = {
      files: allScannedFiles,
      rules: enabledRules
    };

    const advResult = runAllValidators(valContext);
    if (!advResult.valid || advResult.errors.length > 0) {
      logger.error('Advanced Distributed Systems Validators found issues:');
      advResult.errors.forEach(e => logger.error(`  - ${e}`));
      errorsCount += advResult.errors.length;
    } else {
      logger.success(`Advanced Distributed Systems Validators PASSED across ${allScannedFiles.length} generated artifact file(s).`);
    }
    
    if (advResult.warnings.length > 0) {
      logger.warn('Advanced Validators raised warnings:');
      advResult.warnings.forEach(w => logger.warn(`  - ${w}`));
      warningsCount += advResult.warnings.length;
    }

  } else {
    logger.warn(`No generated artifact files found under ${options.target || config.outputDir}. Run "ghk generate" or "ghk add" first.`);
    warningsCount++;
  }

  // 3b. Deployment readiness of a backend (production image, runtime contract, deployment code).
  const readiness = validateDeploymentReadiness(config, outputDirResolved);
  if (readiness.checked) {
    readiness.errors.forEach(e => logger.error(`Deployment readiness: ${e}`));
    readiness.warnings.forEach(w => logger.warn(`Deployment readiness: ${w}`));
    errorsCount += readiness.errors.length;
    warningsCount += readiness.warnings.length;
    if (!readiness.errors.length && !readiness.warnings.length) logger.success('Deployment readiness: production image, runtime contract and deployment code are consistent.');
  }

  // 4. OpenAPI Specification Validation (Optional)
  if (options.openapi) {
    const openapiPath = path.resolve(process.cwd(), options.openapi);
    if (!fileExistsSync(openapiPath)) {
      logger.error(`OpenAPI spec file not found at ${openapiPath}`);
      errorsCount++;
    } else {
      logger.info(`Validating OpenAPI specification: ${options.openapi}`);
      let oaResult;
      
      if (parsedFeatureIR) {
        logger.info(`Cross-referencing OpenAPI with Gherkin IR from ${options.feature}`);
        oaResult = validateOpenAPIAgainstIR(openapiPath, parsedFeatureIR);
      } else {
        oaResult = validateOpenAPISpec(openapiPath);
      }
      
      if (!oaResult.valid) {
        logger.error(`OpenAPI validation failed (${oaResult.specVersion}):`);
        oaResult.errors.forEach(e => logger.error(`  [${e.path}] ${e.message}`));
        errorsCount += oaResult.errors.length;
      } else {
        logger.success(`OpenAPI validation passed (${oaResult.specVersion}).`);
      }
      
      if (oaResult.warnings.length > 0) {
        oaResult.warnings.forEach(w => logger.warn(`  [${w.path}] ${w.message}`));
        warningsCount += oaResult.warnings.length;
      }
    }
  }

  // 5. AsyncAPI Specification Validation (Optional or auto-detect)
  let asyncapiPath = options.asyncapi ? path.resolve(process.cwd(), options.asyncapi) : null;

  // Auto-detect AsyncAPI files in outputDir if not explicitly provided
  if (!asyncapiPath && allScannedFiles.length > 0) {
    const asyncapiFile = pickAsyncApiFile(allScannedFiles.map(f => f.path), outputDirResolved, options.feature);
    if (asyncapiFile) {
      asyncapiPath = asyncapiFile;
      logger.info(`Auto-detected AsyncAPI specification: ${asyncapiPath}`);
    }
  }

  if (asyncapiPath) {
    if (!fileExistsSync(asyncapiPath)) {
      logger.error(`AsyncAPI spec file not found at ${asyncapiPath}`);
      errorsCount++;
    } else {
      logger.info(`Validating AsyncAPI specification: ${path.basename(asyncapiPath)}`);
      let aaResult;

      if (parsedFeatureIR) {
        logger.info(`Cross-referencing AsyncAPI with Gherkin IR from ${options.feature}`);
        aaResult = validateAsyncAPIAgainstIR(asyncapiPath, parsedFeatureIR);
      } else {
        aaResult = validateAsyncAPISpec(asyncapiPath);
      }

      if (!aaResult.valid) {
        logger.error(`AsyncAPI validation failed (${aaResult.specVersion}):`);
        aaResult.errors.forEach(e => logger.error(`  [${e.path}] ${e.message}`));
        errorsCount += aaResult.errors.length;
      } else {
        logger.success(`AsyncAPI validation passed (${aaResult.specVersion}).`);
      }

      if (aaResult.warnings.length > 0) {
        aaResult.warnings.forEach(w => logger.warn(`  [${w.path}] ${w.message}`));
        warningsCount += aaResult.warnings.length;
      }
    }
  }

  console.log('\n------------------------------------------------------------');
  console.log('📊 Architectural Linter Summary Scorecard:');
  console.log(`- Architecture Style: ${arch.name}`);
  console.log(`- Prohibited Imports Guard: ${arch.prohibitedImports.length} rule(s) active`);
  console.log(`- Scanned Artifact Files: ${allScannedFiles.length}`);
  console.log(`- Total Errors: ${errorsCount}`);
  console.log(`- Total Warnings: ${warningsCount}`);
  console.log('------------------------------------------------------------\n');

  if (errorsCount === 0) {
    logger.success('Architectural validation PASSED with 0 errors.');
  } else {
    logger.error(`Validation completed with ${errorsCount} critical issue(s).`);
    process.exitCode = ExitCode.GATE_FAILED;
  }
}
