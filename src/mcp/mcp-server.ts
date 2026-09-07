/* ==========================================================================
   gherkin-ai-cli - Model Context Protocol (MCP) Stdio JSON-RPC 2.0 Server
   
   REFACTORED: All tools now call functions directly instead of execSync.
   Added semantic tools: get_constraints, get_business_rules, lint_spec,
   converge, get_ir, analyze_security.
   ========================================================================== */

import { parseGherkinText } from '../core/gherkin-parser';
import { generateContracts } from '../generators/contracts';
import { detectExistingStack } from '../core/stack-detector';
import { getArchRule } from '../core/arch-rules';
import { loadConfig } from '../core/config';
import { buildIR } from '../core/ir-builder';
import { lintSpecification } from '../core/specification-linter';
import { calculateConvergence } from '../core/convergence-engine';
import { calculateQualityScorecard } from '../core/quality-score';
import { generateConstitution, loadConstitution, getConstraintsByLevel } from '../core/constitution';
import { scanContextSecurity, detectPromptInjection } from '../core/context-security';

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
          version: '2.6.0'
        }
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendJsonRpcResponse(id, { tools: getToolDefinitions() });
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

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

function getToolDefinitions() {
  return [
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
      name: 'build_ir',
      description: 'Build full Semantic Intermediate Representation (IR) from Gherkin text. Returns actors, commands, queries, events, state machines, invariants, constraints, traceability, and quality indicators.',
      inputSchema: {
        type: 'object',
        properties: {
          gherkinText: { type: 'string', description: 'Gherkin feature file content.' },
          mode: { type: 'string', description: 'IR build mode: "deterministic" or "hybrid". Default: deterministic.', enum: ['deterministic', 'hybrid'] }
        },
        required: ['gherkinText']
      }
    },
    {
      name: 'generate_contracts',
      description: 'Generate TypeScript, OpenAPI 3.0, AsyncAPI and native language contracts from Gherkin text.',
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
      name: 'lint_specification',
      description: 'Run specification linter (14 rules) on Gherkin text. Returns diagnostics with severity, suggestions, and a quality score.',
      inputSchema: {
        type: 'object',
        properties: {
          gherkinText: { type: 'string', description: 'Gherkin feature file content.' },
          threshold: { type: 'number', description: 'Minimum passing score (0-100). Default: 70.' }
        },
        required: ['gherkinText']
      }
    },
    {
      name: 'get_constraints',
      description: 'Get all constraints from the project constitution. Optionally filter by level (must, should, may, must-not).',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', description: 'Filter by constraint level.', enum: ['must', 'should', 'may', 'must-not'] }
        }
      }
    },
    {
      name: 'get_business_rules',
      description: 'Extract business rules, invariants, and state machines from Gherkin text.',
      inputSchema: {
        type: 'object',
        properties: {
          gherkinText: { type: 'string', description: 'Gherkin feature file content.' }
        },
        required: ['gherkinText']
      }
    },
    {
      name: 'check_convergence',
      description: 'Measure spec-to-implementation convergence across 6 dimensions: Specification Quality, Scenario Completeness, Contract Coverage, Architecture Compliance, Security Policy, Traceability.',
      inputSchema: {
        type: 'object',
        properties: {
          gherkinText: { type: 'string', description: 'Gherkin feature file content.' }
        },
        required: ['gherkinText']
      }
    },
    {
      name: 'calculate_quality',
      description: 'Calculate project quality scorecard across specification, unit tests, integration tests, E2E, type safety, and security dimensions.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'init_enterprise',
      description: 'Initialize project with enterprise constitution guardrails. Creates .gherkin-ai/ directory with constitution.yaml, agents/, policies/, templates/ and evaluations/.',
      inputSchema: {
        type: 'object',
        properties: {
          enterprise: { type: 'boolean', description: 'Enable enterprise mode with full constitution.' }
        }
      }
    },
    {
      name: 'scan_security',
      description: 'Scan text for secrets, PII, and prompt injection attempts before sending to LLMs.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Content to scan for security issues.' },
          redact: { type: 'boolean', description: 'If true, returns a redacted version of the content.' }
        },
        required: ['content']
      }
    },
    {
      name: 'get_constitution',
      description: 'Read the current project constitution (architecture constraints, security policies, stack configuration, agent permissions).',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool Call Handlers
// ---------------------------------------------------------------------------

function handleToolCall(id: number | string, name: string, args: any): void {
  try {
    switch (name) {
      case 'parse_gherkin': {
        const parsed = parseGherkinText(args.gherkinText || '');
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }]
        });
        break;
      }

      case 'build_ir': {
        const parsed = parseGherkinText(args.gherkinText || '');
        const ir = buildIR(parsed, 'mcp-input.feature', {
          mode: args.mode || 'deterministic'
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(ir, null, 2) }]
        });
        break;
      }

      case 'generate_contracts': {
        const config = loadConfig();
        if (args.language) config.stack.language = args.language;
        if (args.architecture) config.architecture = args.architecture;
        const parsed = parseGherkinText(args.gherkinText || '');
        const output = generateContracts(parsed, config);
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }]
        });
        break;
      }

      case 'detect_stack': {
        const targetDir = args.projectDir || process.cwd();
        const detected = detectExistingStack(targetDir);
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(detected, null, 2) }]
        });
        break;
      }

      case 'validate_architecture': {
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
        break;
      }

      case 'lint_specification': {
        const parsed = parseGherkinText(args.gherkinText || '');
        const result = lintSpecification(parsed, 'mcp-input.feature', {
          threshold: args.threshold || 70,
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        });
        break;
      }

      case 'get_constraints': {
        const constitution = loadConstitution();
        let constraints;
        if (args.level) {
          constraints = getConstraintsByLevel(constitution, args.level);
        } else {
          constraints = constitution?.constraints || [];
        }
        // Also include architecture required/forbidden
        const archConstraints = [];
        if (constitution?.architecture?.required) {
          for (const r of constitution.architecture.required) {
            archConstraints.push({ level: 'must', description: r, category: 'architecture' });
          }
        }
        if (constitution?.architecture?.forbidden) {
          for (const f of constitution.architecture.forbidden) {
            archConstraints.push({ level: 'must-not', description: f, category: 'architecture' });
          }
        }
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({
            constraints: [...(constraints || []), ...archConstraints],
            constitution: constitution ? {
              architecture: constitution.architecture,
              security: {
                dataClassification: constitution.security?.dataClassification,
                authProvider: constitution.security?.authProvider,
              },
              stack: constitution.stack,
            } : null,
          }, null, 2) }]
        });
        break;
      }

      case 'get_business_rules': {
        const parsed = parseGherkinText(args.gherkinText || '');
        const ir = buildIR(parsed, 'mcp-input.feature');
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({
            invariants: ir.invariants,
            stateMachines: ir.stateMachines,
            commands: ir.commands,
            events: ir.events,
            actors: ir.actors,
            assumptions: ir.assumptions,
            risks: ir.risks,
          }, null, 2) }]
        });
        break;
      }

      case 'check_convergence': {
        const parsed = parseGherkinText(args.gherkinText || '');
        const report = calculateConvergence(parsed, 'mcp-input.feature');
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
        });
        break;
      }

      case 'calculate_quality': {
        const scorecard = calculateQualityScorecard();
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(scorecard, null, 2) }]
        });
        break;
      }

      case 'init_enterprise': {
        generateConstitution({ enterprise: true });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            message: 'Enterprise constitution initialized in .gherkin-ai/',
            created: [
              '.gherkin-ai/constitution.yaml',
              '.gherkin-ai/agents/',
              '.gherkin-ai/policies/',
              '.gherkin-ai/templates/',
              '.gherkin-ai/evaluations/',
            ]
          }, null, 2) }]
        });
        break;
      }

      case 'scan_security': {
        const injectionCheck = detectPromptInjection(args.content || '');
        const securityScan = scanContextSecurity(args.content || '', {
          redact: args.redact || false,
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({
            promptInjection: injectionCheck,
            contextSecurity: securityScan,
          }, null, 2) }]
        });
        break;
      }

      case 'get_constitution': {
        const constitution = loadConstitution();
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(constitution || { error: 'No constitution found. Run init_enterprise to create one.' }, null, 2) }]
        });
        break;
      }

      default:
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
