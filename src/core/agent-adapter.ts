/* ==========================================================================
   gherkin-ai-cli - Agnostic Agent Adapter Interface & Provider Engine
   ========================================================================== */

export interface AgentTask {
  id: string;
  type: 'spec_generation' | 'scaffold_binding' | 'auto_fix' | 'security_review';
  prompt: string;
  contextFiles?: string[];
  diagnosis?: any;
}

export interface AgentResult {
  success: boolean;
  codeModifications?: { filePath: string; content: string }[];
  agentResponse: string;
}

export interface AgentProvider {
  name: string;
  executeTask(task: AgentTask): Promise<AgentResult>;
}

export class DefaultCliAgentProvider implements AgentProvider {
  name = 'Default CLI Agent';

  async executeTask(task: AgentTask): Promise<AgentResult> {
    // Generates executable prompt instructions for human/agent execution loop
    return {
      success: true,
      agentResponse: `[Agent Prompt Package Created for ${task.type}]\n\nTask: ${task.prompt}\n\nContext Files: ${task.contextFiles?.join(', ') || 'N/A'}`
    };
  }
}
