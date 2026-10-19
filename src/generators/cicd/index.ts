/* ==========================================================================
   gherkin-ai-cli - CI/CD pipelines (config.ci.provider)

   Opt-in: ci.provider (github | gitlab | azure-devops), or GitHub Actions
   when config.deploy is set. Files are written at the repository root.
   ========================================================================== */

import type { GherkinAIConfig } from '../../core/config';
import { renderAzurePipelines } from './azure-pipelines';
import { renderGitHubWorkflow } from './github';
import { renderGitLabCi } from './gitlab';
import { ciProvider, pipelineSpec } from './pipeline-spec';

/** Pipeline files, with paths relative to the repository root. */
export function renderCiPipelines(config: GherkinAIConfig): { filename: string; content: string }[] {
  const provider = ciProvider(config);
  if (!provider) return [];
  const spec = pipelineSpec(config, provider);
  switch (provider) {
    case 'github': return [renderGitHubWorkflow(spec)];
    case 'gitlab': return [renderGitLabCi(spec)];
    case 'azure-devops': return [renderAzurePipelines(spec)];
  }
}
