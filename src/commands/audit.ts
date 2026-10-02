/* ==========================================================================
   gherkin-ai-cli - 'audit' Command Handler (Feature Inventory & Audit Trail)
   ========================================================================== */

import { emitJson } from '../utils/output';
import { getTelemetry } from '../core/telemetry';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { InventoryManager } from '../core/inventory';

export async function handleAuditCommand(options: { feature?: string; json?: boolean; clear?: boolean; html?: boolean }): Promise<void> {
  const manager = new InventoryManager();

  if (options.clear) {
    manager.clearInventory();
    // Clearing is itself a security-relevant event: keep a record in the append-only audit trail.
    getTelemetry().recordAudit({ action: 'audit:clear-inventory', status: 'SUCCESS' });
    logger.success('Feature audit trail inventory cleared successfully.');
    return;
  }

  const isJson = options.json || process.argv.includes('--json');
  const isHtml = options.html || process.argv.includes('--html');

  if (!isJson && !isHtml) {
    logger.banner();
    logger.info('Retrieving Feature Implementation & Prompt Audit Records...');
  }

  const records = manager.getInventory(options.feature);

  if (isJson) {
    emitJson(records);
    return;
  }

  if (isHtml) {
    const htmlReport = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Gherkin-AI Audit & Compliance Report</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; padding: 40px; background: #f8f9fa; color: #333; }
    h1 { color: #0d6efd; border-bottom: 2px solid #0d6efd; padding-bottom: 10px; }
    .record { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .record-header { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd; padding-bottom: 10px; margin-bottom: 10px; }
    .feature-name { font-weight: bold; font-size: 1.2em; color: #198754; }
    .timestamp { color: #6c757d; font-size: 0.9em; }
    pre { background: #212529; color: #f8f9fa; padding: 15px; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Gherkin-AI Verification & Compliance Audit Report</h1>
  <p>Generated on: ${new Date().toLocaleString()}</p>
  ${records.map(r => `
    <div class="record">
      <div class="record-header">
        <span class="feature-name">Feature: ${r.featureName}</span>
        <span class="timestamp">${new Date(r.timestamp).toLocaleString()}</span>
      </div>
      <div><strong>Command:</strong> ${r.command}</div>
      <div><strong>Status:</strong> ${r.status}</div>
      <div><strong>Stack:</strong> ${r.stack.language} (${r.stack.framework})</div>
      <div><strong>Docker Sandbox:</strong> ${r.dockerSandbox ? 'Yes' : 'No'}</div>
    </div>
  `).join('')}
</body>
</html>`;
    const outputPath = path.resolve('gherkin-ai-audit-report.html');
    fs.writeFileSync(outputPath, htmlReport, 'utf8');
    logger.success(`Compliance HTML report generated successfully at: ${outputPath}`);
    return;
  }

  console.log(manager.formatCLIReport(records));
  logger.success(`Audit trail query complete. (${records.length} record(s) found)`);
}
