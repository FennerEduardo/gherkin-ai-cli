/* ==========================================================================
   gherkin-ai-cli - 'autopilot' Command Handler (Multi-Agent Orchestrator)
   
   Enhanced with:
   - Pre-lint validation of generated specifications
   - IR structural validation (commands, events, scenarios)
   - Structured JSON run logging for traceability
   ========================================================================== */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { buildProjectContext } from '../core/context-builder';
import { calculateDeliveryRisk } from '../core/risk-engine';
import { RealAgentProvider, LLMConfig } from '../core/agent-adapter';
import { handleVerifyCommand } from './verify';
import { loadConfig } from '../core/config';
import { resolveSpecDir } from '../utils/spec-dir-resolver';
import { validateRequirement } from '../core/requirement-validator';

export interface AutopilotOptions {
  requirement?: string;
  autonomous?: boolean;
  command?: string;
}

interface AutopilotRunLog {
  runId: string;
  timestamp: string;
  requirementFile: string;
  requirementScore: number;
  specGenerated: boolean;
  lintScore: number | null;
  irValidation: { commands: number; events: number; scenarios: number } | null;
  scaffoldingResult: 'success' | 'failed' | 'skipped';
  verifyIterations: number;
  riskLevel: string;
  riskScore: number;
  finalStatus: 'success' | 'failed' | 'rolled_back';
}

export async function handleAutopilotCommand(options: AutopilotOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🚀 Launching gherkin-ai Autopilot Autonomous Delivery Orchestrator...\n'));

  const runLog: AutopilotRunLog = {
    runId: `run-${Date.now()}`,
    timestamp: new Date().toISOString(),
    requirementFile: '',
    requirementScore: 0,
    specGenerated: false,
    lintScore: null,
    irValidation: null,
    scaffoldingResult: 'skipped',
    verifyIterations: 0,
    riskLevel: 'UNKNOWN',
    riskScore: 0,
    finalStatus: 'failed'
  };

  const reqFile = options.requirement || 'requirement.md';
  runLog.requirementFile = reqFile;

  if (!fs.existsSync(reqFile)) {
    console.log(chalk.red(`\n✖ Requirement file not found: ${reqFile}`));
    console.log(chalk.yellow(`  → Fix: Provide a valid path with --requirement <file>`));
    console.log(chalk.yellow(`  → Example: ghk autopilot --requirement docs/user-crud.md\n`));
    saveRunLog(runLog);
    process.exitCode = 1;
    return;
  }
  const reqContent = fs.readFileSync(reqFile, 'utf8');

  // Validate requirement before proceeding with agents
  const validation = validateRequirement(reqContent);
  runLog.requirementScore = validation.score;

  if (!validation.isValid) {
    console.log(chalk.red('\n✖ Requirement validation failed:'));
    for (const issue of validation.issues) {
      const icon = issue.severity === 'error' ? '✖' : issue.severity === 'warning' ? '⚠' : 'ℹ';
      const color = issue.severity === 'error' ? chalk.red : issue.severity === 'warning' ? chalk.yellow : chalk.gray;
      console.log(color(`  ${icon} [${issue.severity.toUpperCase()}] ${issue.message}`));
      console.log(chalk.gray(`    → ${issue.suggestion}`));
    }
    console.log(chalk.cyan(`\n  Requirement quality score: ${validation.score}/100`));
    saveRunLog(runLog);
    process.exitCode = 1;
    return;
  }

  // Show warnings even if valid
  const warnings = validation.issues.filter(i => i.severity !== 'error');
  if (warnings.length > 0) {
    console.log(chalk.yellow(`\n⚠ Requirement passed with ${warnings.length} warning(s) (score: ${validation.score}/100):`));
    for (const w of warnings) {
      console.log(chalk.yellow(`  ⚠ ${w.message}`));
    }
    console.log('');
  } else {
    console.log(chalk.green(`✓ Requirement validation passed (score: ${validation.score}/100)\n`));
  }

  const { detectPromptInjection } = require('../core/security-sanitizer');
  const securityCheck = detectPromptInjection(reqContent);
  if (!securityCheck.isSafe) {
    console.log(chalk.red('\n✖ SECURITY ALERT: Prompt Injection Attempt Blocked!'));
    console.log(chalk.red(`  ⚠ Reason: ${securityCheck.reason}`));
    saveRunLog(runLog);
    process.exitCode = 1;
    return;
  }

  const configInstance = loadConfig();

  console.log(chalk.blue(`1. Analyzing repository & building context package...`));
  const context = buildProjectContext();

  const { resolveLLMConfig } = require('../core/agent-adapter');
  const config: LLMConfig = resolveLLMConfig();
  const agent = new RealAgentProvider(config);

  console.log(chalk.blue(`2. Invoking Spec Agent -> Generating Gherkin AST...`));
  let specRes;
  try {
    specRes = await agent.executeTask({
      id: 'auto-spec',
      type: 'spec_generation',
      prompt: `Generate a Gherkin .feature file for the following requirement:\n\n${reqContent}\n\nWrap the code in \`\`\`gherkin ... \`\`\` blocks.`,
      contextFiles: ['.ghe/conventions.md']
    });
  } catch (error: any) {
    console.log(chalk.red(`\n✖ Spec Agent execution crashed: ${error.message}`));
    saveRunLog(runLog);
    process.exitCode = 1;
    return;
  }

  let specContent = '';
  if (specRes.success && specRes.codeModifications && specRes.codeModifications.length > 0) {
    let specDirPath = process.env.GHK_SPEC_DIR || configInstance.specDir || 'specs';
    try {
      specDirPath = resolveSpecDir(configInstance.specDir);
    } catch {
      // Use fallback if none found (specDirPath retains the fallback value)
    }

    for (const mod of specRes.codeModifications) {
      let p = mod.filePath;
      if (!p.endsWith('.feature')) {
        p = path.join(specDirPath, p);
      } else if (!p.includes('/') && !p.includes('\\')) {
        p = path.join(specDirPath, p);
      }
      const { resolveSafePath } = require('../utils/file-system');
      const fullPath = resolveSafePath(process.cwd(), p);
      
      if (process.env.GHK_DRY_RUN === 'true') {
        if (process.env.GHK_STDOUT === 'true') {
          console.log(chalk.yellow(`   [DRY RUN] Proposed spec for ${p}:\n${mod.content}`));
        } else {
          const patchDir = path.resolve('.ghe', 'patches');
          fs.mkdirSync(patchDir, { recursive: true });
          const patchPath = path.join(patchDir, path.basename(p) + '.proposed');
          fs.writeFileSync(patchPath, mod.content, 'utf8');
          console.log(chalk.yellow(`   [DRY RUN] Saved proposed spec to ${patchPath}`));
        }
      } else {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, mod.content);
        console.log(chalk.green(`   ✓ Wrote specification to ${p}`));
      }
      
      if (mod.filePath.endsWith('.feature')) {
        specContent = mod.content;
      }
    }
    runLog.specGenerated = true;
  } else {
    const { saveFailedAttemptLog } = require('../core/agent-adapter');
    const logPath = saveFailedAttemptLog('auto-spec', reqContent, specRes?.agentResponse || 'No response', 'Failed to extract valid code modifications');
    console.log(chalk.red(`\n✖ Spec Agent failed to generate valid code blocks.`));
    console.log(chalk.yellow(`  Response from Agent:\n${specRes.agentResponse.substring(0, 300)}...\n`));
    console.log(chalk.cyan(`  → Diagnostics log saved to: ${logPath}\n`));
    saveRunLog(runLog);
    process.exitCode = 1;
    return;
  }

  // ── Pre-Lint Validation of Generated Spec ──────────────────────────
  if (specContent) {
    try {
      const { parseGherkinText } = require('../core/gherkin-parser');
      const { lintSpecification } = require('../core/specification-linter');
      const { buildIR } = require('../core/ir-builder');

      const parsed = parseGherkinText(specContent);
      const lintResult = lintSpecification(parsed, 'autopilot-generated.feature');
      runLog.lintScore = lintResult.score;

      console.log(chalk.blue(`   🔍 Pre-lint score of generated spec: ${lintResult.score}/100`));

      if (lintResult.score < 60) {
        console.log(chalk.red(`   ✖ Generated specification quality is too low (${lintResult.score}/100). Minimum: 60.`));
        for (const d of lintResult.diagnostics.filter((d: any) => d.severity === 'error').slice(0, 5)) {
          console.log(chalk.red(`     ✖ [${d.ruleId}] ${d.message}`));
        }
        console.log(chalk.yellow(`   → Consider improving the requirement document and retrying.\n`));
        saveRunLog(runLog);
        process.exitCode = 1;
        return;
      }

      // IR Structural Validation
      const ir = buildIR(parsed, 'autopilot-generated.feature');
      runLog.irValidation = {
        commands: ir.commands?.length || 0,
        events: ir.events?.length || 0,
        scenarios: ir.scenarios?.length || 0
      };

      console.log(chalk.blue(`   🧠 IR Validation: ${ir.commands?.length || 0} command(s), ${ir.events?.length || 0} event(s), ${ir.scenarios?.length || 0} scenario(s)`));

      if ((ir.commands?.length || 0) === 0 && (ir.events?.length || 0) === 0) {
        console.log(chalk.yellow(`   ⚠ Warning: Generated spec has no extractable commands or events. Agent prompts may lack context.`));
      }
    } catch (lintErr: any) {
      console.log(chalk.yellow(`   ⚠ Pre-lint skipped: ${lintErr.message}`));
    }
  }

  console.log(chalk.blue(`3. Invoking Scaffolding Agent -> Generating Bindings...`));
  let scaffoldRes;
  try {
    scaffoldRes = await agent.executeTask({
      id: 'auto-scaffold',
      type: 'scaffold_binding',
      prompt: `Generate step definitions for the following spec:\n\n${specContent}\n\nWrap code in \`\`\`ts ... \`\`\``,
      contextFiles: []
    });
  } catch (error: any) {
    console.log(chalk.red(`\n✖ Scaffolding Agent execution crashed: ${error.message}`));
    runLog.scaffoldingResult = 'failed';
    saveRunLog(runLog);
    process.exitCode = 1;
    return;
  }

  if (scaffoldRes.success && scaffoldRes.codeModifications && scaffoldRes.codeModifications.length > 0) {
    runLog.scaffoldingResult = 'success';
    const { validateTypeScriptSyntax } = require('../core/syntax-validator');
    for (const mod of scaffoldRes.codeModifications) {
      if (!validateTypeScriptSyntax(mod.filePath, mod.content)) {
        console.log(chalk.yellow(`     ✖ Skipped writing ${mod.filePath} due to syntax errors.`));
        continue;
      }
      
      const { validateGuardrails } = require('../core/guardrails');
      const guardrailValidation = validateGuardrails({
        action: 'generate_code',
        targetFiles: [mod.filePath]
      }, process.cwd());
      
      if (!guardrailValidation.allowed) {
        console.log(chalk.red(`     ✖ GUARDRAIL VIOLATION: Agent changes rejected for ${mod.filePath}.`));
        for (const v of guardrailValidation.violations) {
          console.log(chalk.red(`       - ${v}`));
        }
        continue;
      }

      const { resolveSafePath } = require('../utils/file-system');
      const fullPath = resolveSafePath(process.cwd(), mod.filePath);
      
      if (process.env.GHK_DRY_RUN === 'true') {
        if (process.env.GHK_STDOUT === 'true') {
          console.log(chalk.yellow(`   [DRY RUN] Proposed bindings for ${mod.filePath}:\n${mod.content}`));
        } else {
          const patchDir = path.resolve('.ghe', 'patches');
          fs.mkdirSync(patchDir, { recursive: true });
          const patchPath = path.join(patchDir, path.basename(mod.filePath) + '.proposed');
          fs.writeFileSync(patchPath, mod.content, 'utf8');
          console.log(chalk.yellow(`   [DRY RUN] Saved proposed bindings to ${patchPath}`));
        }
      } else {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, mod.content);
        console.log(chalk.green(`   ✓ Wrote bindings to ${mod.filePath}`));
      }
    }
  } else {
    const { saveFailedAttemptLog } = require('../core/agent-adapter');
    const logPath = saveFailedAttemptLog('auto-scaffold', specContent, scaffoldRes?.agentResponse || 'No response', 'Failed to extract valid code modifications');
    console.log(chalk.red(`\n✖ Scaffolding Agent failed to generate valid code blocks.`));
    console.log(chalk.yellow(`  Response from Agent:\n${scaffoldRes.agentResponse.substring(0, 300)}...\n`));
    console.log(chalk.cyan(`  → Diagnostics log saved to: ${logPath}\n`));
    runLog.scaffoldingResult = 'failed';
    saveRunLog(runLog);
    process.exitCode = 1;
    return;
  }

  console.log(chalk.blue(`4. Invoking Verification Agent & Closed-Loop Repair...`));
  await handleVerifyCommand({ autoFix: true, maxRetries: 2, command: options.command });

  console.log(chalk.blue(`5. Evaluating Enterprise Quality Score Gate...`));
  const riskCard = calculateDeliveryRisk(process.cwd(), configInstance.specDir);
  runLog.riskLevel = riskCard.riskLevel;
  runLog.riskScore = riskCard.overallRiskScore;

  console.log('\n======================================================');
  console.log(chalk.bold('  Autopilot Deployment Risk Assessment'));
  console.log('======================================================');
  const riskColor = riskCard.riskLevel === 'CRITICAL' || riskCard.riskLevel === 'HIGH' ? chalk.red : 
                    riskCard.riskLevel === 'MEDIUM' ? chalk.yellow : chalk.green;

  console.log(chalk.bold(`Risk Level:   ${riskColor(riskCard.riskLevel)} (Score: ${riskCard.overallRiskScore})`));
  if (riskCard.requiresHumanApproval) {
    console.log(chalk.red('⚠ This change is highly risky and requires human approval.'));
    runLog.finalStatus = 'failed';
  } else {
    console.log(chalk.green('✅ This change is considered safe for autonomous delivery.'));
    runLog.finalStatus = 'success';
  }
  console.log('\nRun `ghk quality` to see a detailed risk breakdown.\n');

  saveRunLog(runLog);
}

function saveRunLog(log: AutopilotRunLog): void {
  try {
    const logDir = path.resolve('.gherkin-ai', 'logs', 'autopilot');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${log.runId}.json`);
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
    console.log(chalk.gray(`  📄 Run log saved to: ${logPath}`));
  } catch {
    // Non-critical: don't crash if logging fails
  }
}
