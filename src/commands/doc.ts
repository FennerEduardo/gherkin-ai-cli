import { generateLivingDocumentation } from '../core/doc-engine';
import { logger } from '../utils/logger';

export async function handleDocCommand(): Promise<void> {
  logger.banner();
  logger.info('Generating Living Documentation from specifications...');
  
  try {
    const result = generateLivingDocumentation(process.cwd());
    logger.success(`Living Documentation successfully generated!`);
    logger.info(`📝 Wrote ${result.filesGenerated} markdown files to: ${result.outputDir}`);
    logger.info(`You can now serve this folder using VitePress, Docusaurus, or view it natively in GitHub/GitLab.`);
  } catch (error: any) {
    logger.error(`Failed to generate documentation: ${error.message}`);
    process.exit(1);
  }
}
