import * as fs from 'fs';
import * as path from 'path';

export interface ExecutionMetrics {
  runId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  tokensUsed: number;
  filesModified: number;
  testRuns: number;
  testFailures: number;
  humanInterventions: number;
  agentAttempts: number;
  requirementsCovered: number;
  totalRequirements: number;
  developmentValueEfficiency: number;
  requirementCoveragePct: number;
}

export class MetricsEngine {
  private metrics: Partial<ExecutionMetrics> = {};
  private workspaceDir: string;

  constructor(workspaceDir: string = process.cwd()) {
    this.workspaceDir = workspaceDir;
    this.metrics.runId = `run_${Date.now()}`;
    this.metrics.startTime = new Date().toISOString();
    this.metrics.testRuns = 0;
    this.metrics.testFailures = 0;
    this.metrics.humanInterventions = 0;
    this.metrics.agentAttempts = 0;
    this.metrics.tokensUsed = 0;
    this.metrics.filesModified = 0;
  }

  public recordAgentAttempt(tokens: number = 0, filesChanged: number = 0) {
    this.metrics.agentAttempts = (this.metrics.agentAttempts || 0) + 1;
    this.metrics.tokensUsed = (this.metrics.tokensUsed || 0) + tokens;
    this.metrics.filesModified = (this.metrics.filesModified || 0) + filesChanged;
  }

  public recordTestRun(passed: boolean) {
    this.metrics.testRuns = (this.metrics.testRuns || 0) + 1;
    if (!passed) {
      this.metrics.testFailures = (this.metrics.testFailures || 0) + 1;
    }
  }

  public recordHumanIntervention() {
    this.metrics.humanInterventions = (this.metrics.humanInterventions || 0) + 1;
  }

  public setRequirements(covered: number, total: number) {
    this.metrics.requirementsCovered = covered;
    this.metrics.totalRequirements = total;
  }

  public calculateFinalMetrics(): ExecutionMetrics {
    this.metrics.endTime = new Date().toISOString();
    this.metrics.durationMs = new Date(this.metrics.endTime).getTime() - new Date(this.metrics.startTime!).getTime();
    
    const covered = this.metrics.requirementsCovered || 0;
    const totalReq = this.metrics.totalRequirements || 1;
    this.metrics.requirementCoveragePct = (covered / totalReq) * 100;

    // DVE = Verified Useful Output / (Human Intervention + Agent Cost)
    // Here we define Useful Output as covered requirements + successful test runs
    const usefulOutput = covered + ((this.metrics.testRuns || 0) - (this.metrics.testFailures || 0));
    // Cost = interventions + attempts
    const cost = (this.metrics.humanInterventions || 0) + (this.metrics.agentAttempts || 1); 
    
    this.metrics.developmentValueEfficiency = parseFloat((usefulOutput / cost).toFixed(2));

    return this.metrics as ExecutionMetrics;
  }

  public saveExecutionLog(events: any[], errors: any[]) {
    const finalMetrics = this.calculateFinalMetrics();
    const execDir = path.join(this.workspaceDir, '.ghe', 'execution');
    if (!fs.existsSync(execDir)) {
      fs.mkdirSync(execDir, { recursive: true });
    }

    fs.writeFileSync(path.join(execDir, 'run.json'), JSON.stringify(finalMetrics, null, 2), 'utf8');
    fs.writeFileSync(path.join(execDir, 'metrics.json'), JSON.stringify(finalMetrics, null, 2), 'utf8');
    fs.writeFileSync(path.join(execDir, 'failures.json'), JSON.stringify(errors, null, 2), 'utf8');
    
    const eventsPath = path.join(execDir, 'events.jsonl');
    events.forEach(ev => {
      fs.appendFileSync(eventsPath, JSON.stringify(ev) + '\n', 'utf8');
    });

    const report = `# Execution Report - ${finalMetrics.runId}
## Metrics
- **DVE (Development Value Efficiency):** ${finalMetrics.developmentValueEfficiency}
- **Requirement Coverage:** ${finalMetrics.requirementCoveragePct.toFixed(2)}% (${finalMetrics.requirementsCovered}/${finalMetrics.totalRequirements})
- **Duration:** ${finalMetrics.durationMs}ms
- **Agent Attempts:** ${finalMetrics.agentAttempts}
- **Test Runs:** ${finalMetrics.testRuns} (${finalMetrics.testFailures} failures)
- **Human Interventions:** ${finalMetrics.humanInterventions}
- **Tokens Used:** ${finalMetrics.tokensUsed}
- **Files Modified:** ${finalMetrics.filesModified}
`;
    fs.writeFileSync(path.join(execDir, 'final-report.md'), report, 'utf8');
    
    return execDir;
  }
}
