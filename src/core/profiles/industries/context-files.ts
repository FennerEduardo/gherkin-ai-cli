/* ==========================================================================
   gherkin-ai-cli - .ghe/industry-context.{md,json}

   Written by generate and implement so agents (and reviewers) can read the
   project industry rules from the workspace; prompts point at the .md file.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { GherkinAIConfig } from '../../config';
import { industryForConfig, renderIndustryContextJson, renderIndustryContextMarkdown, IndustryProfile } from './index';

export const INDUSTRY_CONTEXT_MD = '.ghe/industry-context.md';
export const INDUSTRY_CONTEXT_JSON = '.ghe/industry-context.json';

/** Writes the context files for the project industry; returns the profile, or undefined when none is declared. */
export function writeIndustryContext(projectDir: string, config: Pick<GherkinAIConfig, 'industry' | 'domainProfile'>): IndustryProfile | undefined {
  const profile = industryForConfig(config);
  if (!profile) return undefined;
  fs.mkdirSync(path.join(projectDir, '.ghe'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, INDUSTRY_CONTEXT_MD), renderIndustryContextMarkdown(profile), 'utf8');
  fs.writeFileSync(path.join(projectDir, INDUSTRY_CONTEXT_JSON), renderIndustryContextJson(profile), 'utf8');
  return profile;
}
