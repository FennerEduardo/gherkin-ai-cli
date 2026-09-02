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

export interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'ide_delegate';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export class DefaultCliAgentProvider implements AgentProvider {
  name = 'IDE/MCP Delegate Agent';

  async executeTask(task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      agentResponse: `[IDE Delegation Prompt for ${task.type}]\n(If you are an AI like Cursor, Claude, or Antigravity reading this, please execute the following task)\n\nTask: ${task.prompt}\n\nContext Files: ${task.contextFiles?.join(', ') || 'N/A'}`
    };
  }
}

export class RealAgentProvider implements AgentProvider {
  name = 'Real LLM Agent';
  constructor(private config: LLMConfig) {}

  async executeTask(task: AgentTask): Promise<AgentResult> {
    if (this.config.provider === 'ide_delegate') {
      return new DefaultCliAgentProvider().executeTask(task);
    }

    const systemPrompt = `You are a Senior Software Engineer AI Agent. Your task is to perform: ${task.type}.
If you are fixing or writing code, output the code in Markdown blocks.
IMPORTANT: Precede each markdown block with the exact file path like this:
**File:** \`path/to/file.ts\`
\`\`\`typescript
// code
\`\`\``;

    const userPrompt = `Task: ${task.prompt}
Context Files: ${task.contextFiles?.join(', ') || 'None'}
Diagnosis: ${task.diagnosis ? JSON.stringify(task.diagnosis, null, 2) : 'None'}`;

    let responseText = '';
    try {
      if (this.config.provider === 'ollama') {
        responseText = await this.callOllama(systemPrompt, userPrompt);
      } else if (this.config.provider === 'openai') {
        responseText = await this.callOpenAI(systemPrompt, userPrompt);
      } else if (this.config.provider === 'anthropic') {
        responseText = await this.callAnthropic(systemPrompt, userPrompt);
      }

      const codeModifications = this.extractCodeModifications(responseText, task.contextFiles || []);

      return {
        success: true,
        agentResponse: responseText,
        codeModifications
      };
    } catch (err: any) {
      return {
        success: false,
        agentResponse: `LLM Error: ${err.message}`
      };
    }
  }

  private async fetchWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxRetries) throw new Error(`HTTP ${res.status} after ${maxRetries} attempts`);
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`\n   ⚠️ API Rate limit or server error (${res.status}). Retrying in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    throw new Error('Unreachable');
  }

  private async callOllama(system: string, user: string): Promise<string> {
    const url = this.config.baseUrl || 'http://localhost:11434/api/generate';
    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model || 'llama3',
        system,
        prompt: user,
        stream: false
      })
    });
    const data: any = await res.json();
    return data.response;
  }

  private async callOpenAI(system: string, user: string): Promise<string> {
    const url = this.config.baseUrl || 'https://api.openai.com/v1/chat/completions';
    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model || 'gpt-4o',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const data: any = await res.json();
    return data.choices[0].message.content;
  }

  private async callAnthropic(system: string, user: string): Promise<string> {
    const url = this.config.baseUrl || 'https://api.anthropic.com/v1/messages';
    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.config.model || 'claude-3-opus-20240229',
        system,
        max_tokens: 4000,
        messages: [{ role: 'user', content: user }]
      })
    });
    const data: any = await res.json();
    return data.content[0].text;
  }

  private extractCodeModifications(text: string, contextFiles: string[]): { filePath: string; content: string }[] {
    const mods: { filePath: string; content: string }[] = [];
    
    // Regex looks for "**File:** `path/to/file`" followed by a code block
    const blockRegex = /\*\*File:\*\*\s*`([^`]+)`[\s\S]*?```[\w]*\n([\s\S]*?)```/g;
    let match;
    let found = false;

    while ((match = blockRegex.exec(text)) !== null) {
      found = true;
      mods.push({ filePath: match[1].trim(), content: match[2].trim() });
    }

    // Fallback: if no **File:** markers were found, use the old naive extraction
    if (!found) {
      const fallbackRegex = /```[\w]*\n([\s\S]*?)```/g;
      let i = 0;
      while ((match = fallbackRegex.exec(text)) !== null) {
        if (contextFiles[i]) {
          mods.push({ filePath: contextFiles[i], content: match[1].trim() });
        }
        i++;
      }
    }

    return mods;
  }
}
