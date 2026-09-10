import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentLogManager } from '../../src/core/agent-logger';
import fs from 'fs';
import path from 'path';

describe('Agent Action Log Engine', () => {
  const workspaceDir = path.join(__dirname, 'temp-agent-log-workspace');

  beforeEach(() => {
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('should record an agent action and save it to .ghe/agent_logs.json', () => {
    const manager = new AgentLogManager(workspaceDir);
    const actionDesc = 'Scaffolded Vue3 Application';
    const featureName = 'Frontend Dashboard';

    const record = manager.recordAction(featureName, actionDesc);

    expect(record).not.toBeNull();
    expect(record.logId).toBeDefined();
    expect(record.logId).toContain('act_');
    expect(record.featureName).toBe(featureName);
    expect(record.action).toBe(actionDesc);
    expect(record.agentId.name).toBeDefined();

    const gheFile = path.join(workspaceDir, '.ghe', 'agent_logs.json');
    expect(fs.existsSync(gheFile)).toBe(true);

    const savedRecords = manager.getLogs();
    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0].action).toBe(actionDesc);
  });

  it('should filter agent logs by feature name or action', () => {
    const manager = new AgentLogManager(workspaceDir);

    manager.recordAction('Customer Management', 'Created controller');
    manager.recordAction('Order Processing', 'Created service');
    manager.recordAction('Customer Management', 'Wrote unit tests');

    const all = manager.getLogs();
    expect(all).toHaveLength(3);

    const customerLogs = manager.getLogs('Customer');
    expect(customerLogs).toHaveLength(2);
    expect(customerLogs[0].featureName).toBe('Customer Management');
    expect(customerLogs[1].featureName).toBe('Customer Management');

    const serviceLogs = manager.getLogs('service');
    expect(serviceLogs).toHaveLength(1);
    expect(serviceLogs[0].featureName).toBe('Order Processing');
  });

  it('should cap the max entries to prevent file bloating', () => {
    const manager = new AgentLogManager(workspaceDir);
    
    // Simulate 505 logs, but limit is 500 internally
    for (let i = 1; i <= 505; i++) {
      manager.recordAction('Spam Feature', `Action ${i}`);
    }

    const records = manager.getLogs();
    expect(records).toHaveLength(500);
    // The first record returned should be the most recently inserted one (Action 505)
    expect(records[0].action).toBe('Action 505');
    // The last record should be Action 6
    expect(records[499].action).toBe('Action 6');
  });

  it('should format the CLI report beautifully grouped by feature', () => {
    const manager = new AgentLogManager(workspaceDir);
    manager.recordAction('Auth System', 'Implemented JWT');
    manager.recordAction('Auth System', 'Added User Entity');
    manager.recordAction('Payment Gateway', 'Configured Stripe');

    const records = manager.getLogs();
    const report = manager.formatCLIReport(records);

    expect(report).toContain('AI AGENT ACTION WALKTHROUGH LOG');
    expect(report).toContain('Feature: Auth System');
    expect(report).toContain('Implemented JWT');
    expect(report).toContain('Added User Entity');
    expect(report).toContain('Feature: Payment Gateway');
    expect(report).toContain('Configured Stripe');
  });

  it('should return a friendly message if no logs are found', () => {
    const manager = new AgentLogManager(workspaceDir);
    const report = manager.formatCLIReport([]);
    expect(report).toContain('No agent action logs found');
  });

  it('should clear logs when requested', () => {
    const manager = new AgentLogManager(workspaceDir);
    manager.recordAction('Feature X', 'Action Y');
    
    expect(manager.getLogs()).toHaveLength(1);
    
    manager.clearLogs();
    expect(manager.getLogs()).toHaveLength(0);
    const gheFile = path.join(workspaceDir, '.ghe', 'agent_logs.json');
    expect(fs.existsSync(gheFile)).toBe(false);
  });
});
