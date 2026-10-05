/* ==========================================================================
   gherkin-ai-cli - 'agent-log' Command Handler
   ========================================================================== */

import { emitJson } from '../utils/output';
import { getTelemetry } from '../core/telemetry';
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
    // Clearing is itself a security-relevant event: keep a record in the append-only audit trail.
    getTelemetry().recordAudit({ action: 'agent-log:clear', status: 'SUCCESS' });
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
    emitJson(records);
    return;
  }

  console.log(manager.formatCLIReport(records));
}
