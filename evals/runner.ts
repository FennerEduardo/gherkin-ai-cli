import fs from 'fs';
import path from 'path';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { calculateConvergence } from '../src/core/convergence-engine';
import { lintSpecification } from '../src/core/specification-linter';
import { AgentPolicyEngine } from '../src/core/governance/agent-policy-engine';
import { CrossServiceImpactAnalyzer } from '../src/core/analysis/cross-service-impact';
import { buildIR } from '../src/core/ir-builder';

const domains = ['ecommerce', 'banking', 'logistics'];
let passCount = 0;
let failCount = 0;

console.log('🧪 Starting Gherkin AI Benchmark & Governance Eval Suite...\n');

for (const domain of domains) {
  const domainDir = path.join(__dirname, 'domains', domain);
  const inputDir = path.join(domainDir, 'input');
  
  if (!fs.existsSync(inputDir)) {
    // Scaffold basic inputs if missing so CI doesn't fail on first run
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, 'sample.feature'), `Feature: Basic ${domain} Flow\n  Scenario: Success\n    Given a user\n    When the user acts\n    Then success is returned\n`);
  }

  const features = fs.readdirSync(inputDir).filter(f => f.endsWith('.feature'));

  if (features.length === 0) {
    console.log(`⚠️  [SKIPPED] Domain '${domain}': No feature files found.`);
    continue;
  }

  console.log(`\n============================================================`);
  console.log(`🔍 Domain: ${domain.toUpperCase()}`);
  console.log(`============================================================\n`);

  for (const featureFile of features) {
    console.log(`▶ Evaluating: ${featureFile}`);
    try {
      const gherkinText = fs.readFileSync(path.join(inputDir, featureFile), 'utf8');
      
      // 1. Parser & IR extraction stability
      const parsed = parseGherkinText(gherkinText);
      if (!parsed || !parsed.scenarios) {
        throw new Error('IR Parsing failed to generate scenarios array');
      }

      // 2. Convergence Engine Stability
      const convergence = calculateConvergence(parsed, featureFile);
      if (convergence.overallConvergence === undefined) {
        throw new Error('Convergence calculation returned invalid payload');
      }

      // 3. Linter Stability
      const lint = lintSpecification(parsed, featureFile);
      if (lint.score === undefined) {
        throw new Error('Linter calculation returned invalid payload');
      }

      // 4. Governance & Impact Analysis Evaluation
      const policyEngine = new AgentPolicyEngine(process.cwd());
      const policyResult = policyEngine.evaluateFileModifications(['src/index.ts', 'specs/sample.feature']);
      if (!policyResult.allowed) {
        throw new Error('Policy evaluation failed unexpectedly for valid files');
      }

      const impactAnalyzer = new CrossServiceImpactAnalyzer();
      const specIr = buildIR(parsed, featureFile);
      const impactResult = impactAnalyzer.analyzeImpact(specIr, ['schema.prisma']);
      if (impactResult.riskLevel !== 'CRITICAL') {
        throw new Error('Impact analysis failed to detect CRITICAL risk for schema.prisma modification');
      }

      console.log(`  └─ IR Extracted: ${parsed.scenarios.length} scenarios, ${parsed.domainAnalysis.commands.length} commands`);
      console.log(`  └─ Convergence Score: ${convergence.overallConvergence}%`);
      console.log(`  └─ Lint Score: ${lint.score}%`);
      console.log(`  └─ Governance Risk Engine: ${impactResult.riskLevel} (Blast Radius validated)`);
      console.log(`  ✅ PASS\n`);
      passCount++;
    } catch (e: any) {
      console.error(`  ❌ FAIL: ${e.message}\n`);
      failCount++;
    }
  }
}

console.log(`\n------------------------------------------------------------`);
console.log(`🏁 EVALUATION SUMMARY`);
console.log(`------------------------------------------------------------`);
console.log(`Total Passed : \x1b[32m${passCount}\x1b[0m`);
console.log(`Total Failed : \x1b[31m${failCount}\x1b[0m`);
console.log(`Total Evaluated: ${passCount + failCount}`);

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
