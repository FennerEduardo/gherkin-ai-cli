/* ==========================================================================
   gherkin-ai-cli - 'audit' Command Handler (Feature Inventory & Audit Trail)
   ========================================================================== */

import { logger } from '../utils/logger';
import { InventoryManager } from '../core/inventory';

export async function handleAuditCommand(options: { feature?: string; json?: boolean; clear?: boolean }): Promise<void> {
  const manager = new InventoryManager();

  if (options.clear) {
    manager.clearInventory();
    logger.success('Feature audit trail inventory cleared successfully.');
    return;
  }

  const isJson = options.json || process.argv.includes('--json');

  if (!isJson) {
    logger.banner();
    logger.info('Retrieving Feature Implementation & Prompt Audit Records...');
  }

  const records = manager.getInventory(options.feature);

  if (isJson) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  console.log(manager.formatCLIReport(records));
  logger.success(`Audit trail query complete. (${records.length} record(s) found)`);
}
