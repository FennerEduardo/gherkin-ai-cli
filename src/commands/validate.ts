/* ==========================================================================
   gherkin-ai-cli - Architectural Linter & 'validate' Command Handler
   ========================================================================== */

import path from 'path';
import { loadConfig } from '../core/config';
import { getArchRule } from '../core/arch-rules';
import { parseGherkinText } from '../core/gherkin-parser';
import { fileExistsSync, readFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';
import { Project } from 'ts-morph';
import { validateOpenAPIAgainstIR, validateOpenAPISpec } from '../core/openapi-validator';

export async function handleValidateCommand(options: { feature?: string; config?: string; openapi?: string }): Promise<void> {
  logger.banner();
  logger.info('Validating project architecture, step coverage & layer boundaries...');

  const config = loadConfig(options.config);
  const arch = getArchRule(config.architecture);

  logger.info(`Architecture Rule Target: ${arch.name} (${arch.id})`);
  logger.info(`Stack: ${config.stack.language} + ${config.stack.framework} + ${config.stack.orm}`);

  let errorsCount = 0;
  let warningsCount = 0;
  let parsedFeatureIR: any = null;

  // 1. Gherkin AST & Step Coverage Analysis
  if (options.feature) {
    const featurePath = path.resolve(process.cwd(), options.feature);
    if (!fileExistsSync(featurePath)) {
      logger.error(`Feature file not found at ${featurePath}`);
      errorsCount++;
    } else {
      const gherkinText = readFileSync(featurePath);
      const parsed = parseGherkinText(gherkinText);
      parsedFeatureIR = parsed;
      
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
      }
    }
  }

  // 2. Contracts & Layer Boundary Verification via AST (ts-morph)
  const tsProject = new Project();
  const outputDirGlob = path.posix.join(config.outputDir.replace(/\\/g, '/'), '**/*.ts');
  const sourceFiles = tsProject.addSourceFilesAtPaths(outputDirGlob);

  if (sourceFiles.length > 0) {
    let prohibitedFound = false;

    for (const sourceFile of sourceFiles) {
      const imports = sourceFile.getImportDeclarations();
      for (const importDecl of imports) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        arch.prohibitedImports.forEach(imp => {
          if (moduleSpecifier === imp || moduleSpecifier.startsWith(`${imp}/`)) {
            logger.error(`Layer Boundary Violation: ${sourceFile.getBaseName()} imports prohibited library "${imp}"`);
            errorsCount++;
            prohibitedFound = true;
          }
        });
      }
    }

    if (!prohibitedFound) {
      logger.success(`Layer Boundary Check: ${sourceFiles.length} files scanned via AST. Core cleanly isolates domain from ${arch.prohibitedImports.join(', ')}.`);
    }
  } else {
    logger.warn(`No .ts files found under ${config.outputDir}. Run "npx gherkin-ai generate" first.`);
    warningsCount++;
  }

  // 3. OpenAPI Specification Validation (Optional)
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

  // 4. Final Validation Summary Scorecard
  console.log('\n------------------------------------------------------------');
  console.log('📊 Architectural Linter Summary Scorecard:');
  console.log(`- Architecture Style: ${arch.name}`);
  console.log(`- Prohibited Imports Guard: ${arch.prohibitedImports.length} rule(s) active`);
  console.log(`- Total Errors: ${errorsCount}`);
  console.log(`- Total Warnings: ${warningsCount}`);
  console.log('------------------------------------------------------------\n');

  if (errorsCount === 0) {
    logger.success('Architectural validation PASSED with 0 errors.');
  } else {
    logger.error(`Validation completed with ${errorsCount} critical issue(s).`);
  }
}
