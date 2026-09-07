/* ==========================================================================
   gherkin-ai-cli - 'sbom' Command Handler (Supply Chain Security)
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import chalk from 'chalk';
import { logger } from '../utils/logger';

export async function handleSbomCommand(): Promise<void> {
  logger.banner();
  logger.info('Generating Software Bill of Materials (SBOM)...');

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    logger.error('No package.json found in current directory. Cannot generate SBOM.');
    process.exitCode = 1;
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const dependencies = Object.entries(pkg.dependencies || {}).map(([name, version]) => ({
    type: 'library',
    name,
    version: (version as string).replace(/^[\\^~]/, ''),
    purl: `pkg:npm/${name}@${(version as string).replace(/^[\\^~]/, '')}`
  }));

  const devDependencies = Object.entries(pkg.devDependencies || {}).map(([name, version]) => ({
    type: 'library',
    name,
    version: (version as string).replace(/^[\\^~]/, ''),
    purl: `pkg:npm/${name}@${(version as string).replace(/^[\\^~]/, '')}`
  }));

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.4',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: pkg.name || 'unknown-app',
        version: pkg.version || '0.0.0'
      }
    },
    components: [...dependencies, ...devDependencies]
  };

  const outDir = path.join(process.cwd(), '.ghe');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'cyclonedx.json');
  fs.writeFileSync(outPath, JSON.stringify(sbom, null, 2), 'utf8');

  console.log(chalk.green(`\n✅ SBOM successfully generated!`));
  console.log(chalk.cyan(`   Location: ${outPath}`));
  console.log(chalk.cyan(`   Components found: ${sbom.components.length}\n`));
}
