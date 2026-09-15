import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetricsEngine } from '../../src/core/metrics-engine';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');
vi.mock('path', async () => {
  const actualPath = await vi.importActual('path') as any;
  return {
    ...actualPath,
    join: (...args: string[]) => args.join('/')
  };
});

describe('MetricsEngine', () => {
  let engine: MetricsEngine;
  let workspaceDir = '/tmp/test-workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new MetricsEngine(workspaceDir);
  });

  it('initializes with default values', () => {
    const metrics = engine.calculateFinalMetrics();
    expect(metrics.runId).toBeDefined();
    expect(metrics.testRuns).toBe(0);
    expect(metrics.testFailures).toBe(0);
    expect(metrics.humanInterventions).toBe(0);
    expect(metrics.agentAttempts).toBe(0);
    expect(metrics.tokensUsed).toBe(0);
  });

  it('records agent attempts correctly', () => {
    engine.recordAgentAttempt(1000, 2);
    engine.recordAgentAttempt(500, 1);
    
    const metrics = engine.calculateFinalMetrics();
    expect(metrics.agentAttempts).toBe(2);
    expect(metrics.tokensUsed).toBe(1500);
    expect(metrics.filesModified).toBe(3);
  });

  it('records test runs and failures', () => {
    engine.recordTestRun(true); // Pass
    engine.recordTestRun(false); // Fail
    
    const metrics = engine.calculateFinalMetrics();
    expect(metrics.testRuns).toBe(2);
    expect(metrics.testFailures).toBe(1);
  });

  it('records human interventions', () => {
    engine.recordHumanIntervention();
    engine.recordHumanIntervention();
    
    const metrics = engine.calculateFinalMetrics();
    expect(metrics.humanInterventions).toBe(2);
  });

  it('calculates requirement coverage', () => {
    engine.setRequirements(8, 10);
    const metrics = engine.calculateFinalMetrics();
    expect(metrics.requirementCoveragePct).toBe(80);
  });

  it('calculates DVE accurately', () => {
    // DVE = Verified Useful Output / (Human Intervention + Agent Cost)
    // Useful Output = requirementsCovered + (testRuns - testFailures)
    
    engine.setRequirements(5, 10); // 5 useful output
    engine.recordTestRun(true); // +1 useful output
    engine.recordTestRun(false); // +0 useful output, +1 run, +1 fail -> (2 runs - 1 fail) = 1 successful test
    
    // total useful output = 5 + (2 - 1) = 6
    
    engine.recordHumanIntervention(); // +1 cost
    engine.recordAgentAttempt(100, 1); // +1 cost
    engine.recordAgentAttempt(100, 1); // +1 cost
    
    // total cost = 1 + 2 = 3
    
    // DVE = 6 / 3 = 2.0
    const metrics = engine.calculateFinalMetrics();
    expect(metrics.developmentValueEfficiency).toBe(2);
  });

  it('saves execution logs to correct paths', () => {
    (fs.existsSync as any).mockReturnValue(false);
    
    engine.setRequirements(10, 10);
    engine.recordAgentAttempt(1000, 2);
    engine.recordTestRun(true);
    
    const execEvents = [{ type: 'test' }];
    const execErrors = [{ msg: 'error' }];
    
    const logPath = engine.saveExecutionLog(execEvents, execErrors);
    
    expect(logPath).toBe(`${workspaceDir}/.ghe/execution`);
    expect(fs.mkdirSync).toHaveBeenCalledWith(logPath, { recursive: true });
    
    // Ensure all 4 files are written
    expect(fs.writeFileSync).toHaveBeenCalledWith(`${logPath}/run.json`, expect.any(String), 'utf8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(`${logPath}/metrics.json`, expect.any(String), 'utf8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(`${logPath}/failures.json`, expect.any(String), 'utf8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(`${logPath}/final-report.md`, expect.any(String), 'utf8');
    
    // Ensure events.jsonl is appended
    expect(fs.appendFileSync).toHaveBeenCalledWith(`${logPath}/events.jsonl`, expect.any(String), 'utf8');
  });
});
