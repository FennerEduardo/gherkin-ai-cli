import { reviewPullRequest } from '../core/pr-reviewer';
import { loadConfig } from '../core/config';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

export interface PrReviewCommandOptions {
  feature: string;
  diff?: string; // Path to a patch file
}

export async function handlePrReviewCommand(options: PrReviewCommandOptions): Promise<void> {
  logger.banner();
  logger.info('Starting CI/CD PR Review AI Bot...');

  if (!options.feature) {
    logger.error('You must specify a feature file with --feature');
    process.exit(1);
  }

  let diffContent = '';

  // If a diff file is provided, read it. Otherwise, read from stdin (for piped commands like `git diff | ghk pr-review`)
  if (options.diff) {
    const diffPath = path.resolve(process.cwd(), options.diff);
    if (!fs.existsSync(diffPath)) {
      logger.error(`Diff file not found: ${diffPath}`);
      process.exit(1);
    }
    diffContent = fs.readFileSync(diffPath, 'utf8');
  } else {
    // Basic synchronous stdin read for CI environments
    try {
      diffContent = fs.readFileSync(0, 'utf8');
    } catch (e) {
      logger.error('Could not read diff from stdin. Please pipe a git diff or use --diff <file>');
      process.exit(1);
    }
  }

  if (!diffContent || diffContent.trim() === '') {
    logger.warn('Empty diff provided. Nothing to review.');
    process.exit(0);
  }

  const config = loadConfig();

  logger.info('Analyzing Pull Request diff against Gherkin IR via LLM...');

  try {
    const result = await reviewPullRequest(diffContent, options.feature, config, process.cwd());

    console.log('\n============================================================');
    console.log(`🤖 AI PR REVIEW RESULT`);
    console.log('============================================================\n');
    
    if (result.approved) {
      console.log(`✅ VERDICT: \x1b[32mAPPROVED\x1b[0m`);
    } else {
      console.log(`❌ VERDICT: \x1b[31mCHANGES REQUESTED\x1b[0m`);
    }

    console.log(`\n📄 Summary:`);
    console.log(result.summary);

    if (result.comments && result.comments.length > 0) {
      console.log(`\n💬 Inline Comments:`);
      result.comments.forEach(c => {
        console.log(`  - [${c.file}:${c.line}] ${c.message}`);
      });
    }

    console.log('\n============================================================\n');

    if (!result.approved) {
      process.exit(1);
    }
  } catch (error: any) {
    logger.error(`PR Review failed: ${error.message}`);
    process.exit(1);
  }
}
