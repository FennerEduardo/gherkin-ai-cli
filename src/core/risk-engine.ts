/* ==========================================================================
   gherkin-ai-cli - Deployment Risk Engine
   
   Calculates a Risk Score (LOW, MEDIUM, HIGH, CRITICAL) for AI modifications
   based on Blast Radius, Test Strength, Security Sensitivity, and Drift.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { parseGherkinText } from './gherkin-parser';
import { buildSpecificationIR } from './ir-builder';
import { resolveSpecDir } from '../utils/spec-dir-resolver';
import { scanContextSecurity } from './context-security';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DeliveryRiskScorecard {
  blastRadius: number; // 0-100
  testStrength: number; // 0-100
  securitySensitivity: number; // 0-100
  architectureDrift: number; // 0-100
  overallRiskScore: number; // 0-100 (higher = riskier)
  riskLevel: RiskLevel;
  requiresHumanApproval: boolean;
  factors: string[];
}

export function calculateDeliveryRisk(cwd: string = process.cwd(), specDirOverride?: string): DeliveryRiskScorecard {
  let blastRadius = 0;
  let testStrength = 0;
  let securitySensitivity = 0;
  let architectureDrift = 0;
  const factors: string[] = [];

  // Parse IR to determine true business risk
  let hasAuth = false;
  let totalEndpoints = 0;
  let totalEvents = 0;
  let totalCommands = 0;

  try {
    const specDirPath = resolveSpecDir(specDirOverride, cwd);
    if (fs.existsSync(specDirPath)) {
      const files = fs.readdirSync(specDirPath).filter((f: string) => f.endsWith('.feature'));
      if (files.length > 0) {
        for (const file of files) {
          const raw = fs.readFileSync(path.join(specDirPath, file), 'utf8');
          const parsed = parseGherkinText(raw);
          const ir = buildSpecificationIR(parsed, file);
          
          if (ir.policies.some(p => p.type === 'authorization' || p.type === 'security')) hasAuth = true;
          totalEndpoints += ir.apiEndpoints.length;
          totalEvents += ir.events.length;
          totalCommands += ir.commands.length;
        }
      }
    }
  } catch (e) {
    // skip
  }

  // 1. Blast Radius
  const totalModifications = totalEndpoints + totalEvents + totalCommands;
  blastRadius = Math.min(100, totalModifications * 10);
  if (blastRadius > 50) factors.push(`High blast radius: affects ${totalModifications} core domain components`);

  // 2. Test Strength
  try {
    const covPath = path.join(cwd, 'coverage', 'coverage-summary.json');
    if (fs.existsSync(covPath)) {
      const data = JSON.parse(fs.readFileSync(covPath, 'utf8'));
      if (data.total && data.total.lines) {
        testStrength = Math.round(data.total.lines.pct || 0);
      }
    } else {
      const testsExist = fs.existsSync(path.join(cwd, 'tests')) || fs.existsSync(path.join(cwd, 'src', '__tests__')) || fs.existsSync(path.join(cwd, 'src', 'test'));
      testStrength = testsExist ? 40 : 0;
    }
  } catch {
    testStrength = 0;
  }
  if (testStrength < 50) factors.push(`Low test strength (${testStrength}%)`);

  // 3. Security Sensitivity
  securitySensitivity = hasAuth ? 80 : 20;
  
  let aggregatedContent = '';
  try {
    const sampleFiles = ['package.json', 'src/index.ts', 'gherkin-ai.config.json'];
    for (const sf of sampleFiles) {
      const p = path.join(cwd, sf);
      if (fs.existsSync(p)) {
        aggregatedContent += fs.readFileSync(p, 'utf8') + '\n';
      }
    }
    const securityScan = scanContextSecurity(aggregatedContent);
    if (securityScan.secretCount > 0) {
      securitySensitivity = 100;
      factors.push('Hardcoded secrets detected in context');
    }
  } catch {
    // skip
  }
  if (hasAuth) factors.push('Modification involves authentication/authorization flows');

  // 4. Architecture Drift
  architectureDrift = 30; // Baseline drift

  let overallRiskScore = (blastRadius * 0.4) + (securitySensitivity * 0.4) + (architectureDrift * 0.2) - (testStrength * 0.3);
  overallRiskScore = Math.max(0, Math.min(100, Math.round(overallRiskScore)));

  let riskLevel: RiskLevel = 'LOW';
  if (overallRiskScore > 80) riskLevel = 'CRITICAL';
  else if (overallRiskScore > 60) riskLevel = 'HIGH';
  else if (overallRiskScore > 30) riskLevel = 'MEDIUM';

  return {
    blastRadius,
    testStrength,
    securitySensitivity,
    architectureDrift,
    overallRiskScore,
    riskLevel,
    requiresHumanApproval: riskLevel === 'HIGH' || riskLevel === 'CRITICAL',
    factors
  };
}
