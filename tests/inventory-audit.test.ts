import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InventoryManager, getAuthorDetails, calculateHash } from '../src/core/inventory';
import fs from 'fs';
import path from 'path';

describe('Feature Inventory & Audit Trail Engine', () => {
  const workspaceDir = path.join(__dirname, 'temp-inventory-workspace');

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

  it('should detect developer author details or fallback safely', () => {
    const author = getAuthorDetails();
    expect(author.name).toBeDefined();
    expect(author.email).toBeDefined();
    expect(['git', 'env', 'fallback']).toContain(author.source);
  });

  it('should calculate 8-character SHA-256 hashes for specs and prompts', () => {
    const hash1 = calculateHash('Feature: Customer Management');
    const hash2 = calculateHash('Feature: Customer Management');
    const hash3 = calculateHash('Feature: Order Management');

    expect(hash1).toHaveLength(8);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it('should record execution in .ghe/inventory.json and formatted audit trail', () => {
    const manager = new InventoryManager(workspaceDir);

    const record = manager.recordExecution({
      featureName: 'Customer Management',
      featurePath: 'features/01-customer-management.feature',
      featureVersionHash: 'a1b2c3d4',
      promptVersionHash: 'prt_9e8d7c6b',
      author: { name: 'Fenner Eduardo', email: 'fenner@example.com', source: 'git' },
      command: 'ghk implement',
      stack: {
        language: 'php',
        framework: 'native-php',
        architecture: 'monolith',
        testing: 'phpunit'
      },
      dockerSandbox: true,
      dockerImage: 'php:8.3-cli-alpine',
      status: 'PROMPT_GENERATED'
    });

    expect(record.recordId).toBeDefined();
    expect(record.recordId).toContain('rec_');

    const gheFile = path.join(workspaceDir, '.ghe', 'inventory.json');
    expect(fs.existsSync(gheFile)).toBe(true);

    const savedRecords = manager.getInventory();
    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0].featureName).toBe('Customer Management');
    expect(savedRecords[0].author.name).toBe('Fenner Eduardo');

    const report = manager.formatCLIReport(savedRecords);
    expect(report).toContain('Customer Management');
    expect(report).toContain('Fenner Eduardo');
    expect(report).toContain('a1b2c3d4');
  });

  it('should filter inventory records by feature name or path', () => {
    const manager = new InventoryManager(workspaceDir);

    manager.recordExecution({
      featureName: 'Customer Management',
      featurePath: 'features/01-customer-management.feature',
      featureVersionHash: 'a1b2c3d4',
      promptVersionHash: 'prt_11111111',
      author: { name: 'Dev 1', email: 'dev1@example.com', source: 'git' },
      command: 'ghk implement',
      stack: { language: 'php', framework: 'native-php', architecture: 'monolith', testing: 'phpunit' },
      dockerSandbox: true,
      status: 'PROMPT_GENERATED'
    });

    manager.recordExecution({
      featureName: 'Billing Management',
      featurePath: 'features/02-billing-management.feature',
      featureVersionHash: 'e5f6g7h8',
      promptVersionHash: 'prt_22222222',
      author: { name: 'Dev 2', email: 'dev2@example.com', source: 'git' },
      command: 'ghk implement',
      stack: { language: 'typescript', framework: 'nestjs', architecture: 'monolith', testing: 'vitest' },
      dockerSandbox: false,
      status: 'PROMPT_GENERATED'
    });

    const all = manager.getInventory();
    expect(all).toHaveLength(2);

    const customerOnly = manager.getInventory('customer');
    expect(customerOnly).toHaveLength(1);
    expect(customerOnly[0].featureName).toBe('Customer Management');

    const billingOnly = manager.getInventory('02-billing');
    expect(billingOnly).toHaveLength(1);
    expect(billingOnly[0].featureName).toBe('Billing Management');
  });
});
