/* ==========================================================================
   gherkin-ai-cli - 'audit' Command Handler (Feature Inventory & Audit Trail)
   ========================================================================== */

import { logger } from '../utils/logger';
import { InventoryManager } from '../core/inventory';

export async function handleAuditCommand(options: { feature?: string; json?: boolean }): Promise<void> {
  const isJson = options.json || process.argv.includes('--json');

  if (!isJson) {
    logger.banner();
    logger.info('Retrieving Feature Implementation & Prompt Audit Records...');
  }

  const manager = new InventoryManager();
  const records = manager.getInventory(options.feature);

  if (isJson) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  console.log(manager.formatCLIReport(records));
  logger.success(`Audit trail query complete. (${records.length} record(s) found)`);
}
