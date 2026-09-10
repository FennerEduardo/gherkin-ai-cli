/* ==========================================================================
   gherkin-ai-cli - 'implement' Command Handler (AI Agent Orchestration)
   ========================================================================== */

import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { loadConfig } from '../core/config';
import { parseGherkinText } from '../core/gherkin-parser';
import { fileExistsSync, readFileSync, writeFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';
import { resolveSpecDir } from '../utils/spec-dir-resolver';

export async function handleImplementCommand(options: { feature?: string; yes?: boolean }): Promise<void> {
  logger.banner();
  logger.info('Preparing AI Agent Implementation Package & Master Prompt...');

  const config = loadConfig();
  let featurePath: string = '';

  if (options.feature) {
    featurePath = path.resolve(process.cwd(), options.feature);
  } else {
    try {
      const specDir = resolveSpecDir(config.specDir, process.cwd());
      const files = fs.readdirSync(specDir).filter(f => f.endsWith('.feature'));
      if (files.length > 0) {
        featurePath = path.join(specDir, files[0]);
        logger.info(`Auto-selected feature: ${featurePath}`);
      }
    } catch {}
  }

  if (!featurePath || !fileExistsSync(featurePath)) {
    logger.error('No feature file found to implement.');
    logger.info('  → Fix: Run "ghk generate --feature ./features/01-customer-management.feature" first.');
    return;
  }

  const gherkinText = readFileSync(featurePath);
  const parsed = parseGherkinText(gherkinText);
  const featureName = parsed.featureName || path.basename(featurePath, '.feature');
  const basePascal = featureName.replace(/[^a-zA-Z0-9]/g, '');

  const lang = config.stack.language.toLowerCase();
  const outDir = config.outputDir || './generated-specs';

  // Locate associated contracts and governance files
  const relativeFeature = path.relative(process.cwd(), featurePath);
  const govPath = fileExistsSync(path.join(process.cwd(), '.ghkgovernance.yaml'))
    ? '.ghkgovernance.yaml'
    : undefined;

  let nativeContractPath: string | undefined;
  const contractExts = ['.contract.php', '.contract.py', '.contract.go', '.contract.cs', 'contracts.ts'];
  
  for (const ext of contractExts) {
    const candidate = path.join(outDir, `${basePascal.toLowerCase()}${ext}`);
    if (fileExistsSync(candidate)) {
      nativeContractPath = path.relative(process.cwd(), candidate);
      break;
    }
  }

  if (!nativeContractPath && fileExistsSync(path.join(outDir, 'contracts.ts'))) {
    nativeContractPath = path.relative(process.cwd(), path.join(outDir, 'contracts.ts'));
  }

  const adrPath = fileExistsSync(path.join(outDir, 'ADR-001-architecture-decisions.md'))
    ? path.relative(process.cwd(), path.join(outDir, 'ADR-001-architecture-decisions.md'))
    : undefined;

  const openApiPath = fileExistsSync(path.join(outDir, 'openapi.json'))
    ? path.relative(process.cwd(), path.join(outDir, 'openapi.json'))
    : undefined;

  // Build Master Orchestration Prompt
  const refFiles: string[] = [];
  if (govPath) refFiles.push(`@${govPath}`);
  refFiles.push(`@${relativeFeature}`);
  if (nativeContractPath) refFiles.push(`@${nativeContractPath}`);
  if (adrPath) refFiles.push(`@${adrPath}`);
  if (openApiPath) refFiles.push(`@${openApiPath}`);

  const masterPromptContent = `# 🚀 AI AGENT MASTER IMPLEMENTATION PROMPT
## Feature: ${featureName}
## Architecture: ${config.architecture.toUpperCase()} | Stack: ${config.stack.language.toUpperCase()} (${config.stack.framework})

### 📌 Context Files to Read & Follow:
${refFiles.map(f => `- ${f}`).join('\n')}

### 🛠️ Technical Guardrails & Stack Specifications:
- **Language**: ${config.stack.language} (${config.stack.framework})
- **Persistence**: ${config.stack.orm} + ${config.stack.database}
- **Validation**: ${config.stack.validation}
- **Testing Framework**: ${config.stack.testing}

### 🎯 Mandatory Step-by-Step Implementation Flow:

#### Phase 1: Pure Domain Layer
1. Read the feature specification in \`${relativeFeature}\` and contract in \`${nativeContractPath || 'contracts.ts'}\`.
2. Implement pure domain Entities, Value Objects, and Domain Events.
3. Ensure zero dependencies on external frameworks or database drivers in the domain core.

#### Phase 2: Application Use Cases & Infrastructure
1. Implement the Repository Port interface using ${config.stack.orm.toUpperCase()} (${config.stack.database}).
2. Implement Controllers/Handlers to process HTTP requests and return appropriate status codes (e.g. 201 Created, 400 Bad Request).
3. Apply validation using ${config.stack.validation}.

#### Phase 3: Automated Unit & Feature Testing
1. Implement automated test cases in ${config.stack.testing.toUpperCase()} matching all scenarios in \`${relativeFeature}\`.
2. Assert HTTP response status codes, payload structures, and event emissions.
3. Ensure 100% scenario pass rate.
`;

  // Write Master Prompt file
  const promptFile = path.join(outDir, 'prompts', 'implement-master-prompt.md');
  const promptDir = path.dirname(promptFile);
  if (!fs.existsSync(promptDir)) {
    fs.mkdirSync(promptDir, { recursive: true });
  }
  writeFileSync(promptFile, masterPromptContent);

  // Terminal Output Presentation
  console.log(chalk.bold.green('\n============================================================'));
  console.log(chalk.bold.cyan(`🤖 AI AGENT IMPLEMENTATION PACKAGE GENERATED`));
  console.log(chalk.bold.green('============================================================\n'));

  console.log(chalk.bold('📋 Target Feature: ') + chalk.yellow(featureName));
  console.log(chalk.bold('📂 Feature File:   ') + chalk.white(relativeFeature));
  console.log(chalk.bold('📜 Domain Contract: ') + chalk.white(nativeContractPath || 'N/A'));
  console.log(chalk.bold('🔒 Agent Policy:    ') + chalk.white(govPath || 'N/A'));
  console.log(chalk.bold('📄 Master Prompt:   ') + chalk.white(promptFile));

  console.log(chalk.bold.cyan('\n------------------------------------------------------------'));
  console.log(chalk.bold.yellow('💬 COPY-PASTE THIS PROMPT DIRECTLY TO YOUR AI AGENT:'));
  console.log(chalk.bold.cyan('------------------------------------------------------------\n'));

  const quickPrompt = `${refFiles.join(' ')}

Act as LEAD SOFTWARE ENGINEER & AGENTIC ARCHITECT.
Implement the feature "${featureName}" defined in ${relativeFeature}:

1. Follow the domain contract in ${nativeContractPath || 'contracts.ts'}.
2. Adhere strictly to the architecture (${config.architecture}) and guardrails in ${govPath || '.ghkgovernance.yaml'}.
3. Implement Domain Entities, Infrastructure Repositories (${config.stack.orm}/${config.stack.database}), and MVC Controllers (${config.stack.language}).
4. Implement ${config.stack.testing.toUpperCase()} test suite matching all feature scenarios.
`;

  console.log(chalk.green(quickPrompt));
  console.log(chalk.bold.cyan('------------------------------------------------------------\n'));

  logger.success(`Implementation Package successfully generated! Prompt saved to: ${promptFile}`);
}
