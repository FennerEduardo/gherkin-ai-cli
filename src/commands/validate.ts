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

export async function handleValidateCommand(options: { feature?: string; config?: string }): Promise<void> {
  logger.banner();
  logger.info('Validating project architecture, step coverage & layer boundaries...');

  const config = loadConfig(options.config);
  const arch = getArchRule(config.architecture);

  logger.info(`Architecture Rule Target: ${arch.name} (${arch.id})`);
  logger.info(`Stack: ${config.stack.language} + ${config.stack.framework} + ${config.stack.orm}`);

  let errorsCount = 0;
  let warningsCount = 0;

  // 1. Gherkin AST & Step Coverage Analysis
  if (options.feature) {
    const featurePath = path.resolve(process.cwd(), options.feature);
    if (!fileExistsSync(featurePath)) {
      logger.error(`Feature file not found at ${featurePath}`);
      errorsCount++;
    } else {
      const gherkinText = readFileSync(featurePath);
      const parsed = parseGherkinText(gherkinText);
      
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

  // 3. Final Validation Summary Scorecard
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
