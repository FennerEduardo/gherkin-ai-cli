/* ==========================================================================
   gherkin-ai-cli - 'skill' Command Handler (Agent IDE Integration)
   
   Enhanced: Supports MCP and Skills installation for all major IDEs.
   Can install as MCP server or as skill/rules injection.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { CLI_VERSION } from '../version';

// ---------------------------------------------------------------------------
// Skill Content (every command it names must exist; keep the start marker: updates replace from it)
// ---------------------------------------------------------------------------

const SKILL_CONTENT = `
# Gherkin AI CLI - IDE Agent Skill

You are an AI assistant in an IDE, equipped with the \`gherkin-ai\` CLI (alias: \`ghk\`).
The \`.feature\` files are the source of truth for behavior. Use the CLI to read them, check them and stay inside their scope.

## CONSTRAINTS
Before starting any task:
- Read \`gherkin-ai.config.json\` (stack, architecture, industry) and, when present, \`.gherkin-ai/constitution.yaml\` (architectural guardrails). NEVER violate them.
- When \`.ghe/industry-context.md\` exists, follow its industry rules (standards, vocabulary, compliance).
- Check what you may change: \`ghk firewall policy -f <feature>\`. Paths that need human approval are not yours to edit.

## SPECIFICATION-FIRST WORKFLOW

### 1. Specify
- Lint the specification before writing code: \`ghk lint -f <feature>\`. Fix errors and warnings.
- \`ghk lint --explain-ir -f <feature>\` shows the aggregate, route, commands and events the generator will use. Name them with \`@aggregate:\`, \`@command:\` and \`@event:\` tags when they are generic.

### 2. Generate
- \`ghk generate -f <feature>\` writes contracts (\`contracts/<feature>/\`, \`openapi.json\`, \`asyncapi.json\`), the domain kernel, pending BDD steps, the runtime and the agent prompts (\`prompts/\`) into the configured \`outputDir\`.
- Edited files are never overwritten: the new version is written next to them as \`<file>.ghk-new\`. Do not delete those; the developer resolves them with \`ghk generate --review\`.

### 3. Implement
- \`ghk implement -f <feature>\` prints the implementation prompt and context. READ it and the generated prompts before coding.
- Implement the pending BDD steps and the domain behavior. Keep the generated HTTP contract and the names from the specification.

### 4. Verify
- \`ghk verify\` runs the project tests. \`ghk verify --services\` adds the runtime integration suite against real PostgreSQL and the broker.
- \`ghk converge -f <feature>\` measures specification-to-code convergence. \`ghk validate\` checks the specification and the contracts.
- \`ghk risk --base origin/main\` scores the delivery risk of the change; report it to the developer.

## AVAILABLE COMMANDS
| Command | Description |
|---------|-------------|
| \`ghk lint -f <file>\` | Specification quality rules and score (industry rules included) |
| \`ghk lint --explain-ir -f <file>\` | Where each generated name comes from |
| \`ghk validate\` | Specification and architecture rules; contract checks |
| \`ghk generate -f <file>\` | Contracts, domain kernel, tests, runtime and prompts |
| \`ghk implement -f <file>\` | Implementation prompt and context for the feature |
| \`ghk converge\` | Specification-to-code convergence |
| \`ghk graph --scope <file>\` | Files and tests that belong to a feature |
| \`ghk firewall check --write <path>\` | Whether a write needs human approval |
| \`ghk risk --base <ref>\` | Delivery risk of the change |
| \`ghk verify\` | Run the project tests |
| \`ghk industry show <id>\` | An industry's standards and rules (\`industry.id\` in the configuration) |

Never guess the architecture or the domain names: take them from the specification, the configuration and the CLI.
`;

// ---------------------------------------------------------------------------
// MCP Configuration Templates
// ---------------------------------------------------------------------------

interface McpConfigTemplate {
  name: string;
  filename: string;
  generateConfig: () => any;
}

// The same entry as `ghk mcp install`: pinned, so the server does not change with whatever is latest on npm,
// and portable, unlike a path to this machine's installation.
const PINNED_MCP_ARGS = ['-y', `gherkin-ai@${CLI_VERSION}`, 'mcp'];

function getMcpConfigTemplates(): Record<string, McpConfigTemplate> {
  return {
    'cursor': {
      name: 'Cursor',
      filename: '.cursor/mcp.json',
      generateConfig: () => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'npx',
            args: PINNED_MCP_ARGS,
            env: {}
          }
        }
      }),
    },
    'vscode': {
      name: 'VS Code (Copilot)',
      filename: '.vscode/mcp.json',
      generateConfig: () => ({
        servers: {
          'gherkin-ai': {
            type: 'stdio',
            command: 'npx',
            args: PINNED_MCP_ARGS,
          }
        }
      }),
    },
    'windsurf': {
      name: 'Windsurf (Codeium)',
      filename: '.windsurf/mcp.json',
      generateConfig: () => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'npx',
            args: PINNED_MCP_ARGS,
          }
        }
      }),
    },
    'claude-desktop': {
      name: 'Claude Desktop',
      filename: '',
      generateConfig: () => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'npx',
            args: PINNED_MCP_ARGS,
          }
        }
      }),
    },
    'antigravity': {
      name: 'Antigravity',
      filename: '.gemini/settings.json',
      generateConfig: () => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'npx',
            args: PINNED_MCP_ARGS,
          }
        }
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Skill Rules Templates
// ---------------------------------------------------------------------------

const SKILL_TARGETS: { name: string; value: string }[] = [
  { name: 'Cursor (.cursorrules)', value: '.cursorrules' },
  { name: 'Windsurf (.windsurfrules)', value: '.windsurfrules' },
  { name: 'GitHub Copilot (.github/copilot-instructions.md)', value: '.github/copilot-instructions.md' },
  { name: 'Cline (.clinerules)', value: '.clinerules' },
  { name: 'Antigravity (.gemini/instructions.md)', value: '.gemini/instructions.md' },
  { name: 'Generic (.ai-rules.md)', value: '.ai-rules.md' },
];

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

export async function handleSkillCommand(): Promise<void> {
  const { installMode } = await inquirer.prompt([{
    type: 'list',
    name: 'installMode',
    message: 'How would you like to integrate Gherkin AI with your IDE?',
    choices: [
      { name: '📡 MCP Server (recommended — real-time tools)', value: 'mcp' },
      { name: '📝 Skill/Rules injection (text-based instructions)', value: 'skill' },
      { name: '🔄 Both (MCP + Skill)', value: 'both' },
    ],
  }]);

  if (installMode === 'mcp' || installMode === 'both') {
    await installMcp();
  }

  if (installMode === 'skill' || installMode === 'both') {
    await installSkill();
  }
}

// ---------------------------------------------------------------------------
// MCP Installation
// ---------------------------------------------------------------------------

async function installMcp(): Promise<void> {
  console.log(chalk.bold.cyan('\n📡 MCP Server Configuration\n'));

  const { targetIde } = await inquirer.prompt([{
    type: 'list',
    name: 'targetIde',
    message: 'Which IDE are you configuring MCP for?',
    choices: [
      { name: 'Cursor', value: 'cursor' },
      { name: 'VS Code (GitHub Copilot)', value: 'vscode' },
      { name: 'Windsurf (Codeium)', value: 'windsurf' },
      { name: 'Claude Desktop', value: 'claude-desktop' },
      { name: 'Antigravity', value: 'antigravity' },
    ],
  }]);

  const templates = getMcpConfigTemplates();
  const template = templates[targetIde];

  if (!template) {
    console.log(chalk.red('  ✖ Unknown IDE target.'));
    return;
  }

  const mcpConfig = template.generateConfig();

  if (targetIde === 'claude-desktop') {
    // Claude Desktop uses a global config file
    console.log(chalk.cyan('\n  Add this to your Claude Desktop config (claude_desktop_config.json):\n'));
    console.log(chalk.white(JSON.stringify(mcpConfig, null, 2)));
    console.log(chalk.gray('\n  Location: ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)'));
    console.log(chalk.gray('            %APPDATA%\\Claude\\claude_desktop_config.json (Windows)'));
    return;
  }

  const configPath = path.join(process.cwd(), template.filename);
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Merge with existing config if present
  let finalConfig = mcpConfig;
  if (fs.existsSync(configPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Deep merge MCP servers
      if (existing.mcpServers) {
        existing.mcpServers = { ...existing.mcpServers, ...mcpConfig.mcpServers };
        finalConfig = existing;
      } else if (existing.servers) {
        existing.servers = { ...existing.servers, ...(mcpConfig.servers || {}) };
        finalConfig = existing;
      }
    } catch (e) {
      // If parse fails, overwrite
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(finalConfig, null, 2) + '\n', 'utf8');
  console.log(chalk.green(`\n  ✅ MCP server configured in ${template.filename}`));
  console.log(chalk.cyan('  📡 Read-only tools by default; write tools need "mcp": { "allowWrite": true } (docs/MCP_GUIDE.md).'));
  console.log(chalk.gray(`  🔧 Server: npx ${PINNED_MCP_ARGS.join(' ')}\n`));
}

// ---------------------------------------------------------------------------
// Skill Installation
// ---------------------------------------------------------------------------

async function installSkill(): Promise<void> {
  console.log(chalk.bold.cyan('\n📝 Skill/Rules Installation\n'));

  const { targetIde } = await inquirer.prompt([{
    type: 'list',
    name: 'targetIde',
    message: 'Which AI IDE are you using?',
    choices: SKILL_TARGETS,
  }]);

  const targetPath = path.join(process.cwd(), targetIde);

  if (targetIde.includes('/')) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  let finalContent = SKILL_CONTENT;

  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, 'utf8');
    if (existing.includes('Gherkin AI CLI')) {
      // Update existing skill
      const startMarker = '# Gherkin AI CLI - IDE Agent Skill';
      const startIdx = existing.indexOf(startMarker);
      if (startIdx !== -1) {
        const before = existing.substring(0, startIdx);
        finalContent = before + SKILL_CONTENT.trim();
        console.log(chalk.yellow(`  ⚠ Updated existing Gherkin AI rules in ${targetIde}.`));
      } else {
        console.log(chalk.yellow(`  ⚠ Gherkin AI rules already exist in ${targetIde}.`));
        return;
      }
    } else {
      finalContent = existing + '\n\n' + SKILL_CONTENT;
    }
  }

  fs.writeFileSync(targetPath, finalContent.trim() + '\n', 'utf8');
  console.log(chalk.green(`  ✅ Successfully injected Gherkin AI Skill into ${targetIde}!`));
  console.log(chalk.cyan(`  🤖 Your IDE Agent is now trained to use 'ghk' commands natively.\n`));
}
