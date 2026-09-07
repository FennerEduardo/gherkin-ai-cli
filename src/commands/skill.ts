/* ==========================================================================
   gherkin-ai-cli - 'skill' Command Handler (Agent IDE Integration)
   
   Enhanced: Supports MCP and Skills installation for all major IDEs.
   Can install as MCP server or as skill/rules injection.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';

// ---------------------------------------------------------------------------
// Skill Content (Enhanced)
// ---------------------------------------------------------------------------

const SKILL_CONTENT = `
# Gherkin AI CLI - IDE Agent Skill

You are an AI assistant in an IDE, equipped with the \`gherkin-ai-cli\` (alias: \`ghk\`).
You MUST use this CLI natively to help the user design, validate, and generate code architecture.

## CONSTITUTION & CONSTRAINTS
Before starting any task, read the project constraints:
- Run \`ghk constitution\` to see the project's architectural guardrails.
- NEVER violate the constraints defined in \`.gherkin-ai/constitution.yaml\`.
- Check allowed/forbidden patterns before generating any code.

## SPECIFICATION-FIRST WORKFLOW

### 1. Detection Phase
- If the user asks about the current architecture or stack, run \`ghk detect\` to see the project's config.

### 2. Lint Phase (NEW)
- Before generating code, lint the specification:
  \`ghk lint -f <path-to-file.feature>\`
- Fix any warnings/errors before proceeding.

### 3. Generation Phase
- When the user provides a \`.feature\` file (Gherkin) and asks to implement it, FIRST run:
  \`ghk generate -f <path-to-file.feature>\`
- This generates TypeScript/Native interfaces, DTOs, OpenAPI specs, and agent prompts.

### 4. Implementation Phase
- After generating, READ the prompts in \`./generated-specs/prompts/\`.
- STRICTLY FOLLOW the architecture constraints, layers, and rules defined in those prompts.
- Follow the domain contracts generated in \`./generated-specs/contracts.ts\`.

### 5. Validation & Convergence
- Run \`ghk validate -f <feature-file>\` to verify syntactic correctness.
- Run \`ghk converge\` to measure specification-to-implementation alignment.
- Run \`ghk diff -f <feature-file> -t <code-file>\` to compare spec vs code.

### 6. Quality Gate
- Run \`ghk quality\` to check the project quality score before merging.

### 7. Verification Loop
- Run \`ghk verify --auto-fix\` to execute tests with AI self-healing.

## AVAILABLE COMMANDS
| Command | Description |
|---------|-------------|
| \`ghk detect\` | Auto-detect project stack and architecture |
| \`ghk init --enterprise\` | Initialize project with enterprise constitution |
| \`ghk generate -f <file>\` | Generate contracts, DTOs, prompts from Gherkin |
| \`ghk validate -f <file>\` | Validate Gherkin syntax |
| \`ghk lint -f <file>\` | Lint specification quality (14 rules) |
| \`ghk converge\` | Measure spec-to-implementation convergence |
| \`ghk quality\` | Calculate project quality scorecard |
| \`ghk verify --auto-fix\` | Run tests with AI self-healing loop |
| \`ghk diff -f <spec> -t <code>\` | Compare specification vs implementation |
| \`ghk sbom\` | Generate Software Bill of Materials |
| \`ghk skill\` | Install this skill into your IDE |

Never guess the architecture. Always rely on \`ghk\` CLI and the constitution as the source of truth.
`;

// ---------------------------------------------------------------------------
// MCP Configuration Templates
// ---------------------------------------------------------------------------

interface McpConfigTemplate {
  name: string;
  filename: string;
  generateConfig: (binPath: string) => any;
}

function getMcpConfigTemplates(binPath: string): Record<string, McpConfigTemplate> {
  return {
    'cursor': {
      name: 'Cursor',
      filename: '.cursor/mcp.json',
      generateConfig: (bp) => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'node',
            args: [bp, 'mcp'],
            env: {}
          }
        }
      }),
    },
    'vscode': {
      name: 'VS Code (Copilot)',
      filename: '.vscode/mcp.json',
      generateConfig: (bp) => ({
        servers: {
          'gherkin-ai': {
            type: 'stdio',
            command: 'node',
            args: [bp, 'mcp'],
          }
        }
      }),
    },
    'windsurf': {
      name: 'Windsurf (Codeium)',
      filename: '.windsurf/mcp.json',
      generateConfig: (bp) => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'node',
            args: [bp, 'mcp'],
          }
        }
      }),
    },
    'claude-desktop': {
      name: 'Claude Desktop',
      filename: '',
      generateConfig: (bp) => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'node',
            args: [bp, 'mcp'],
          }
        }
      }),
    },
    'antigravity': {
      name: 'Antigravity',
      filename: '.gemini/settings.json',
      generateConfig: (bp) => ({
        mcpServers: {
          'gherkin-ai': {
            command: 'node',
            args: [bp, 'mcp'],
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

  // Resolve binary path
  const binPath = resolveBinPath();
  const templates = getMcpConfigTemplates(binPath);
  const template = templates[targetIde];

  if (!template) {
    console.log(chalk.red('  ✖ Unknown IDE target.'));
    return;
  }

  const mcpConfig = template.generateConfig(binPath);

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
  console.log(chalk.cyan(`  📡 Available tools: 13 (parse, build_ir, lint, converge, contracts, quality, security...)`));
  console.log(chalk.gray(`  🔧 Binary path: ${binPath}\n`));
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBinPath(): string {
  // Try to find the installed binary path
  const localBin = path.resolve(__dirname, '../../bin/gherkin-ai.js');
  if (fs.existsSync(localBin)) return localBin;

  // Fallback to npx-resolved path
  const nodeModulesBin = path.resolve(process.cwd(), 'node_modules/.bin/gherkin-ai');
  if (fs.existsSync(nodeModulesBin)) return nodeModulesBin;

  // Final fallback: use the global command name
  return 'gherkin-ai';
}
