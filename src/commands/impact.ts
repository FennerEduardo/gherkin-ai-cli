import path from 'path';
import { logger } from '../utils/logger';
import { analyzeImpact } from '../core/impact-analyzer';

export interface ImpactCommandOptions {
  feature?: string;
  json?: boolean;
}

export async function handleImpactCommand(options: ImpactCommandOptions): Promise<void> {
  if (!options.json) {
    logger.banner();
    logger.info('Analyzing blast radius of specification changes...');
  }

  if (!options.feature) {
    logger.error('Feature file is required. Use -f or --feature.');
    process.exit(1);
  }

  const featurePath = path.resolve(process.cwd(), options.feature);
  
  try {
    const report = analyzeImpact(featurePath, process.cwd());

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log('\n============================================================');
    console.log(`💥 BLAST RADIUS IMPACT REPORT: ${report.feature}`);
    console.log('============================================================\n');

    console.log(`Risk Level: ${getRiskBadge(report.riskLevel)}`);
    console.log(`Scenarios Affected Directly: ${report.affectedScenarios}\n`);

    console.log(`[Dependencies Detected]`);
    console.log(`- Downstream Features: ${report.affectedFeatures.length} file(s)`);
    if (report.affectedFeatures.length > 0) {
      report.affectedFeatures.forEach(f => console.log(`  └─ ${f}`));
    }

    console.log(`- Contracts/DTOs: ${report.affectedContracts.length} file(s)`);
    if (report.affectedContracts.length > 0) {
      report.affectedContracts.forEach(c => console.log(`  └─ ${c}`));
    }

    console.log(`- Schemas: ${report.affectedSchemas.length} file(s)`);
    console.log(`- API Endpoints/Swagger: ${report.affectedEndpoints.length} file(s)`);
    console.log(`- Test Suites: ${report.affectedTests} file(s)`);
    
    console.log('\n============================================================\n');

    if (report.riskLevel === 'critical' || report.riskLevel === 'high') {
      logger.warn('This change has a high impact on the system. Proceed with caution and ensure exhaustive testing.');
    } else {
      logger.success('Impact analysis completed.');
    }
  } catch (error: any) {
    logger.error(`Failed to analyze impact: ${error.message}`);
    process.exit(1);
  }
}

function getRiskBadge(level: string): string {
  switch (level) {
    case 'critical': return '\x1b[41m\x1b[37m CRITICAL \x1b[0m';
    case 'high': return '\x1b[45m\x1b[37m HIGH \x1b[0m';
    case 'medium': return '\x1b[43m\x1b[30m MEDIUM \x1b[0m';
    case 'low': return '\x1b[42m\x1b[30m LOW \x1b[0m';
    default: return level;
  }
}
