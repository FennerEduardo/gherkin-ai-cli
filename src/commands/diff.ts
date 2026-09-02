/* ==========================================================================
   gherkin-ai-cli - 'diff' Command Handler (Drift Detection)
   ========================================================================== */

import chalk from 'chalk';
import fs from 'fs';
import { parseGherkinText } from '../core/gherkin-parser';

export interface DiffCommandOptions {
  feature?: string;
  target?: string;
}

export async function handleDiffCommand(options: DiffCommandOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🔍 Running Drift Detection (Gherkin vs Code)...\n'));
  
  if (!options.feature || !options.target) {
     console.log(chalk.red('Please provide both --feature and --target files.'));
     console.log('Example: ghk diff --feature specs/login.feature --target src/dto/login.dto.ts');
     process.exitCode = 1;
     return;
  }

  if (!fs.existsSync(options.feature)) {
     console.log(chalk.red(`Feature file not found: ${options.feature}`));
     process.exitCode = 1;
     return;
  }

  if (!fs.existsSync(options.target)) {
     console.log(chalk.red(`Target code file not found: ${options.target}`));
     process.exitCode = 1;
     return;
  }

  const featureContent = fs.readFileSync(options.feature, 'utf8');
  const targetContent = fs.readFileSync(options.target, 'utf8');

  const parsed = parseGherkinText(featureContent);
  const fields = parsed.domainAnalysis.fields;

  if (fields.length === 0) {
      console.log(chalk.yellow(`⚠ No semantic fields found in ${options.feature}. Ensure you use quotes like "email" to define fields.`));
      return;
  }

  let driftFound = false;

  console.log(chalk.blue(`Checking synchronization for ${fields.length} semantic fields...\n`));

  let targetProperties: string[] = [];
  if (options.target.endsWith('.ts')) {
    try {
      const { Project } = require('ts-morph');
      const project = new Project({ useInMemoryFileSystem: true });
      const sourceFile = project.createSourceFile(options.target, targetContent);
      
      const interfaces = sourceFile.getInterfaces();
      const classes = sourceFile.getClasses();
      
      for (const intf of interfaces) {
        targetProperties.push(...intf.getProperties().map((p: any) => p.getName()));
      }
      for (const cls of classes) {
        targetProperties.push(...cls.getProperties().map((p: any) => p.getName()));
      }
    } catch (e: any) {
       console.log(chalk.yellow(`⚠ Could not parse AST of target file: ${e.message}. Falling back to string match.`));
    }
  }

  for (const field of fields) {
     const isFound = targetProperties.length > 0 
       ? targetProperties.includes(field.name)
       : targetContent.includes(field.name);

     if (!isFound) {
         console.log(chalk.red(`  ✖ Drift Detected! Field '${field.name}' from feature is missing in ${options.target}`));
         driftFound = true;
     } else {
         console.log(chalk.green(`  ✓ Field '${field.name}' is synchronized.`));
     }
  }

  if (driftFound) {
      console.log(chalk.bold.red('\n❌ Drift Detection Failed: The source of truth (.feature) does not match the implementation.'));
      process.exitCode = 1;
  } else {
      console.log(chalk.bold.green('\n✅ No drift detected. Code is synchronized with the Gherkin specification.'));
  }
}
