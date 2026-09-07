import { RealAgentProvider, resolveLLMConfig } from './agent-adapter';
import { GherkinAIConfig } from './config';
import { parseGherkinText } from './gherkin-parser';
import { buildIR } from './ir-builder';
import { getArchRule } from './arch-rules';
import fs from 'fs';
import path from 'path';

export interface PRReviewResult {
  approved: boolean;
  comments: { file: string; line: number; message: string }[];
  summary: string;
}

export async function reviewPullRequest(
  diffContent: string,
  featureFile: string,
  config: GherkinAIConfig,
  projectDir: string
): Promise<PRReviewResult> {
  const gherkinText = fs.readFileSync(path.resolve(projectDir, featureFile), 'utf8');
  const parsed = parseGherkinText(gherkinText);
  const ir = buildIR(parsed, featureFile);
  
  const archRule = getArchRule(config.architecture);
  
  const llmConfig = resolveLLMConfig();
  if (config.stack.aiEngine === 'claude-code') llmConfig.provider = 'anthropic';
  const agent = new RealAgentProvider(llmConfig);

  const prompt = `You are an expert AI Tech Lead reviewing a Pull Request.
The system architecture must follow: ${archRule.name}.
Prohibited imports in Domain: ${archRule.prohibitedImports.join(', ')}.

Here is the Gherkin Specification (Source of Truth):
${JSON.stringify(ir, null, 2)}

Here is the git diff of the Pull Request:
${diffContent}

Analyze the diff against the specification and architecture rules.
Identify any deviations, missing endpoints, incorrect fields, or layer violations.

Respond ONLY with a JSON object in this exact format:
{
  "approved": boolean,
  "summary": "String explaining the overall verdict",
  "comments": [
    { "file": "path/to/file", "line": 10, "message": "Feedback message" }
  ]
}`;

  try {
    const response = await agent.executeTask({
      id: 'pr-review-' + Date.now(),
      type: 'security_review', // Using closest available task type
      prompt: prompt,
      contextFiles: [featureFile]
    });

    const jsonStr = response.agentResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(jsonStr) as PRReviewResult;
    return result;
  } catch (error: any) {
    throw new Error(`AI Review failed: ${error.message}`);
  }
}
