/* ==========================================================================
   gherkin-ai-cli - 'agent-log' Command Handler
   ========================================================================== */

import { AgentLogManager } from '../core/agent-logger';
import { logger } from '../utils/logger';


export async function handleAgentLogCommand(options: { 
  action?: string; 
  feature?: string; 
  list?: boolean; 
  json?: boolean; 
  clear?: boolean 
}): Promise<void> {
  const manager = new AgentLogManager(process.cwd());

  if (options.clear) {
    manager.clearLogs();
    logger.success('Agent action logs cleared successfully.');
    return;
  }

  if (options.action) {
    const featureName = options.feature || 'Global Action';
    manager.recordAction(featureName, options.action);
    logger.success(`Agent action logged for feature: ${featureName}`);
    return;
  }

  // Display logs (list mode)
  const records = manager.getLogs(options.feature);
  
  if (options.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  console.log(manager.formatCLIReport(records));
}
