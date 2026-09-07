/* ==========================================================================
   gherkin-ai-cli - Model Context Protocol (MCP) Stdio JSON-RPC 2.0 Server
   ========================================================================== */

import { parseGherkinText } from '../core/gherkin-parser';
import { generateContracts } from '../generators/contracts';
import { detectExistingStack } from '../core/stack-detector';
import { getArchRule } from '../core/arch-rules';
import { loadConfig } from '../core/config';

export function startMcpServer(): void {
  process.stdin.setEncoding('utf8');

  let buffer = '';

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line.trim());
        handleJsonRpcMessage(message);
      } catch (err) {
        // Send JSON-RPC Parse Error
        sendJsonRpcResponse(null, null, {
          code: -32700,
          message: `Parse error: ${(err as Error).message}`
        });
      }
    }
  });
}

function sendJsonRpcResponse(id: number | string | null, result: any, error: any = null): void {
  const response: any = { jsonrpc: '2.0', id };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}

function handleJsonRpcMessage(message: any): void {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      sendJsonRpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'gherkin-ai-mcp',
          version: '1.5.0'
        }
      });
      break;

    case 'notifications/initialized':
      // Notification, no response needed
      break;

    case 'tools/list':
      sendJsonRpcResponse(id, {
        tools: [
          {
            name: 'parse_gherkin',
            description: 'Parse Gherkin .feature specification text into domain AST (commands, queries, events, actors).',
            inputSchema: {
              type: 'object',
              properties: {
                gherkinText: { type: 'string', description: 'Gherkin feature file content.' }
              },
              required: ['gherkinText']
            }
          },
          {
            name: 'generate_contracts',
            description: 'Generate TypeScript, OpenAPI 3.0, and native language contracts (Python, PHP, Go, C#) from Gherkin text.',
            inputSchema: {
              type: 'object',
              properties: {
                gherkinText: { type: 'string', description: 'Gherkin feature file content.' },
                language: { type: 'string', description: 'Target language (typescript, python, php, go, csharp).' },
                architecture: { type: 'string', description: 'Architecture style (hexagonal, ddd, clean, cqrs, serverless, microservices).' }
              },
              required: ['gherkinText']
            }
          },
          {
            name: 'detect_stack',
            description: 'Auto-detect project tech stack and architecture from workspace root directory.',
            inputSchema: {
              type: 'object',
              properties: {
                projectDir: { type: 'string', description: 'Absolute path to project directory.' }
              }
            }
          },
          {
            name: 'validate_architecture',
            description: 'Validate Gherkin AST step coverage and layer import boundary isolation rules.',
            inputSchema: {
              type: 'object',
              properties: {
                gherkinText: { type: 'string', description: 'Gherkin feature text.' },
                architecture: { type: 'string', description: 'Architecture style to validate against.' }
              },
              required: ['gherkinText']
            }
          },
          {
            name: 'ghk_init_enterprise',
            description: 'Initialize project with enterprise constitution guardrails (.gherkin-ai/constitution.yaml).',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'ghk_verify',
            description: 'Run closed-loop verification test harness. Useful to execute tests and trigger AI self-healing.',
            inputSchema: {
              type: 'object',
              properties: {
                autoFix: { type: 'boolean', description: 'Enable auto-fix agent loop.' },
                command: { type: 'string', description: 'Custom test command.' }
              }
            }
          },
          {
            name: 'ghk_quality',
            description: 'Calculate feature quality score index and enterprise gate compliance.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'ghk_sbom',
            description: 'Generate Software Bill of Materials (CycloneDX cyclonedx.json).',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      });
      break;

    case 'tools/call':
      handleToolCall(id, params?.name, params?.arguments || {});
      break;

    default:
      if (id !== undefined) {
        sendJsonRpcResponse(id, null, {
          code: -32601,
          message: `Method not found: ${method}`
        });
      }
      break;
  }
}

function handleToolCall(id: number | string, name: string, args: any): void {
  try {
    if (name === 'parse_gherkin') {
      const parsed = parseGherkinText(args.gherkinText || '');
      sendJsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }]
      });
    } 
    else if (name === 'generate_contracts') {
      const config = loadConfig();
      if (args.language) config.stack.language = args.language;
      if (args.architecture) config.architecture = args.architecture;

      const parsed = parseGherkinText(args.gherkinText || '');
      const output = generateContracts(parsed, config);

      sendJsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }]
      });
    } 
    else if (name === 'detect_stack') {
      const targetDir = args.projectDir || process.cwd();
      const detected = detectExistingStack(targetDir);
      sendJsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(detected, null, 2) }]
      });
    } 
    else if (name === 'validate_architecture') {
      const parsed = parseGherkinText(args.gherkinText || '');
      const arch = getArchRule(args.architecture || 'hexagonal');

      const scorecard = {
        featureName: parsed.featureName,
        scenariosCount: parsed.scenarios.length,
        commandsCount: parsed.domainAnalysis.commands.length,
        eventsCount: parsed.domainAnalysis.events.length,
        prohibitedImportsGuard: arch.prohibitedImports,
        passed: parsed.scenarios.length > 0
      };

      sendJsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(scorecard, null, 2) }]
      });
    } 
    else if (name === 'ghk_init_enterprise') {
      const { execSync } = require('child_process');
      const out = execSync('node ' + require('path').join(__dirname, '../../bin/gherkin-ai.js') + ' init --enterprise', { encoding: 'utf8' });
      sendJsonRpcResponse(id, { content: [{ type: 'text', text: out }] });
    }
    else if (name === 'ghk_verify') {
      const { execSync } = require('child_process');
      let cmd = 'node ' + require('path').join(__dirname, '../../bin/gherkin-ai.js') + ' verify';
      if (args.autoFix) cmd += ' --auto-fix';
      if (args.command) cmd += ` --command "${args.command}"`;
      try {
        const out = execSync(cmd, { encoding: 'utf8' });
        sendJsonRpcResponse(id, { content: [{ type: 'text', text: out }] });
      } catch (e: any) {
        sendJsonRpcResponse(id, { content: [{ type: 'text', text: (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + e.message }] });
      }
    }
    else if (name === 'ghk_quality') {
      const { execSync } = require('child_process');
      try {
        const out = execSync('node ' + require('path').join(__dirname, '../../bin/gherkin-ai.js') + ' quality', { encoding: 'utf8' });
        sendJsonRpcResponse(id, { content: [{ type: 'text', text: out }] });
      } catch (e: any) {
        sendJsonRpcResponse(id, { content: [{ type: 'text', text: (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + e.message }] });
      }
    }
    else if (name === 'ghk_sbom') {
      const { execSync } = require('child_process');
      try {
        const out = execSync('node ' + require('path').join(__dirname, '../../bin/gherkin-ai.js') + ' sbom', { encoding: 'utf8' });
        sendJsonRpcResponse(id, { content: [{ type: 'text', text: out }] });
      } catch (e: any) {
        sendJsonRpcResponse(id, { content: [{ type: 'text', text: (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + e.message }] });
      }
    }
    else {
      sendJsonRpcResponse(id, null, {
        code: -32601,
        message: `Unknown tool: ${name}`
      });
    }
  } catch (err) {
    sendJsonRpcResponse(id, null, {
      code: -32000,
      message: `Tool execution failed: ${(err as Error).message}`
    });
  }
}
