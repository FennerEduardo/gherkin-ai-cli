import fs from 'fs';
import path from 'path';
import { parseGherkinText } from './gherkin-parser';
import { buildIR } from './ir-builder';
import { loadConfig } from './config';

export interface ImpactReport {
  feature: string;
  affectedFeatures: string[];
  affectedScenarios: number;
  affectedEndpoints: string[];
  affectedSchemas: string[];
  affectedTests: number;
  affectedContracts: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export function analyzeImpact(featureFile: string, projectDir: string): ImpactReport {
  const report: ImpactReport = {
    feature: path.basename(featureFile),
    affectedFeatures: [],
    affectedScenarios: 0,
    affectedEndpoints: [],
    affectedSchemas: [],
    affectedTests: 0,
    affectedContracts: [],
    riskLevel: 'low'
  };

  if (!fs.existsSync(featureFile)) {
    throw new Error(`Feature file not found: ${featureFile}`);
  }

  const config = loadConfig(path.join(projectDir, 'gherkin-ai.config.json'));
  const gherkinText = fs.readFileSync(featureFile, 'utf8');
  const parsed = parseGherkinText(gherkinText);
  const ir = buildIR(parsed, featureFile);

  report.affectedScenarios = ir.scenarios.length;

  // Extract key terms to search for across the workspace
  const keywords = new Set<string>();
  ir.commands.forEach(c => keywords.add(c.name));
  ir.queries.forEach(q => keywords.add(q.name));
  ir.events.forEach(e => keywords.add(e.name));
  ir.apiEndpoints.forEach(e => keywords.add(e.path));
  
  if (keywords.size === 0) {
    return report;
  }

  const keywordArray = Array.from(keywords).filter(k => k.length > 3);

  // Scan workspace files
  const searchDirs = [
    config.outputDir || 'src/contracts',
    config.specDir || 'specs',
    'src',
    'tests'
  ].map(d => path.join(projectDir, d));

  const allFiles = new Set<string>();

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.feature') || fullPath.endsWith('.json') || fullPath.endsWith('.yaml'))) {
        allFiles.add(fullPath);
      }
    }
  };

  searchDirs.forEach(dir => walk(dir));

  // Determine impact
  allFiles.forEach(file => {
    // skip the feature itself
    if (file === path.resolve(featureFile)) return;
    
    try {
      const content = fs.readFileSync(file, 'utf8');
      
      const isMatch = keywordArray.some(kw => content.includes(kw));
      if (isMatch) {
        if (file.endsWith('.feature')) {
          report.affectedFeatures.push(path.basename(file));
        } else if (file.includes('openapi') || file.endsWith('swagger.yaml')) {
          report.affectedEndpoints.push(path.basename(file));
        } else if (file.includes('schema') || file.includes('dto')) {
          report.affectedSchemas.push(path.basename(file));
        } else if (file.includes('.test.') || file.includes('.spec.') || file.includes('tests/')) {
          report.affectedTests++;
        } else if (file.endsWith('.ts')) {
          report.affectedContracts.push(path.basename(file));
        }
      }
    } catch {
      // ignore unreadable files
    }
  });

  // Calculate Risk Level
  const totalImpact = report.affectedFeatures.length + report.affectedEndpoints.length + report.affectedSchemas.length + report.affectedContracts.length;
  
  if (totalImpact > 20) {
    report.riskLevel = 'critical';
  } else if (totalImpact > 10) {
    report.riskLevel = 'high';
  } else if (totalImpact > 3) {
    report.riskLevel = 'medium';
  } else {
    report.riskLevel = 'low';
  }

  // Deduplicate
  report.affectedFeatures = [...new Set(report.affectedFeatures)];
  report.affectedEndpoints = [...new Set(report.affectedEndpoints)];
  report.affectedSchemas = [...new Set(report.affectedSchemas)];
  report.affectedContracts = [...new Set(report.affectedContracts)];

  return report;
}
