/* ==========================================================================
   gherkin-ai-cli - 'export' Command Handler
   ========================================================================== */

import path from 'path';
import { loadConfig } from '../core/config';
import { parseGherkinText } from '../core/gherkin-parser';
import { getArchRule } from '../core/arch-rules';
import { fileExistsSync, readFileSync, writeFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';

export async function handleExportCommand(options: { feature?: string; format?: string; output?: string }): Promise<void> {
  logger.banner();
  const config = loadConfig();
  const arch = getArchRule(config.architecture);

  let gherkinText = `Feature: Default Spec\n  Scenario: Standard Scenario\n    Given system is ready\n    When request is received\n    Then response is ok`;

  if (options.feature) {
    const fPath = path.resolve(process.cwd(), options.feature);
    if (fileExistsSync(fPath)) {
      gherkinText = readFileSync(fPath);
    }
  }

  const parsed = parseGherkinText(gherkinText);
  const isJson = options.format === 'json';

  const exportPayload = isJson
    ? JSON.stringify({
        agentContext: 'gherkin-ai CLI Export',
        timestamp: new Date().toISOString(),
        config,
        architecture: arch,
        parsedFeature: parsed
      }, null, 2)
    : `# AGENT EXPORT BUNDLE - ${parsed.featureName}\n\nArchitecture: ${arch.name}\nLanguage: ${config.stack.language}\nFramework: ${config.stack.framework}\n\n## Requirements\n${parsed.scenarios.map(s => `- Scenario: ${s.name}`).join('\n')}`;

  const destFile = options.output || path.join(process.cwd(), `agent-bundle.${isJson ? 'json' : 'md'}`);
  writeFileSync(destFile, exportPayload);

  logger.success(`Exported AI Agent bundle to: ${destFile}`);
}
