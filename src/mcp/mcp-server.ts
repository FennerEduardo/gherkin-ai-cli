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
import { buildIR, buildSpecificationIR } from '../core/ir-builder';
import { lintSpecification } from '../core/specification-linter';
import { calculateConvergence } from '../core/convergence-engine';
import { calculateDeliveryRisk } from '../core/risk-engine';
import { generateConstitution, loadConstitution, getConstraintsByLevel } from '../core/constitution';
import { scanContextSecurity, detectPromptInjection } from '../core/context-security';
import { SpecHashBaseline } from '../core/governance/spec-hash-baseline';
import { AgentPolicyEngine } from '../core/governance/agent-policy-engine';
import { handleLoginCommand } from '../commands/login';
import { handleInitCommand } from '../commands/init';
import { handleGenerateCommand } from '../commands/generate';
import { handleAddCommand } from '../commands/add';
import { handleCreateCommand } from '../commands/create';
import { handleAuditCommand } from '../commands/audit';
import { handleAgentLogCommand } from '../commands/agent-log';
import { handleImplementCommand } from '../commands/implement';
import { promisify } from 'util';
import { exec } from 'child_process';
import { CrossServiceImpactAnalyzer } from '../core/analysis/cross-service-impact';

const execAsync = promisify(exec);


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
          version: '2.6.1'
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
      name: 'run_cli_diff',
      description: 'Run the ghk diff command to detect drift between a Gherkin feature file and a target source code file.',
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Path to the .feature file.' },
          target: { type: 'string', description: 'Path to the target source code file.' }
        },
        required: ['feature', 'target']
      }
    },
    {
      name: 'run_cli_verify',
      description: 'Run the ghk verify command to execute closed-loop testing.',
      inputSchema: {
        type: 'object',
        properties: {
          autoFix: { type: 'boolean', description: 'Enable auto-fix with agent repair loop if tests fail.' },
          command: { type: 'string', description: 'Custom test command to run.' }
        }
      }
    },
    {
      name: 'run_cli_autopilot',
      description: 'Run the ghk autopilot command to generate and scaffold features autonomously.',
      inputSchema: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: 'Path to the requirement markdown file.' }
        },
        required: ['requirement']
      }
    },
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
    {
      name: 'ghk_governance_check',
      description: 'Evaluate target files against agent policy boundaries and verify SHA-256 specification baselines for drift.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Paths of files the agent intends to create or modify.' }
        },
        required: ['files']
      }
    },
    {
      name: 'ghk_impact_analysis',
      description: 'Calculate multi-service Blast Radius across OpenAPI endpoints, AsyncAPI events, DTOs and DB schemas.',
      inputSchema: {
        type: 'object',
        properties: {
          gherkinText: { type: 'string', description: 'Optional Gherkin feature text.' },
          changedFiles: { type: 'array', items: { type: 'string' }, description: 'List of changed or target files.' }
        }
      }
    },
    {
      name: 'run_cli_init',
      description: 'Initialize project configuration non-interactively with dual-stack backend and frontend settings.',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Project name.' },
          architecture: { type: 'string', description: 'Software architecture (hexagonal, ddd, clean, cqrs, monolith, api-rest, microservices).' },
          language: { type: 'string', description: 'Backend language (java, csharp, typescript, php, python, go, ruby).' },
          framework: { type: 'string', description: 'Backend framework (spring-boot, dotnet-aspnetcore, nestjs, fastapi, laravel, etc.).' },
          orm: { type: 'string', description: 'Database ORM / persistence.' },
          database: { type: 'string', description: 'Database engine (postgresql, mysql, mongodb, sqlite, redis).' },
          validation: { type: 'string', description: 'Validation library (jakarta-validation, fluent-validation, zod, etc.).' },
          messaging: { type: 'string', description: 'Event broker (rabbitmq, kafka, sqs, redis-pubsub, native-events, none).' },
          testing: { type: 'string', description: 'Testing framework (junit, xunit, vitest, jest, pytest, phpunit).' },
          frontendFramework: { type: 'string', description: 'Frontend framework (angular, react, vue, vanilla-js, none).' },
          frontendLanguage: { type: 'string', description: 'Frontend language (typescript, javascript).' },
          frontendStateManagement: { type: 'string', description: 'Frontend state pattern (signals, classic, pinia, redux-toolkit).' },
          enterprise: { type: 'boolean', description: 'Enable enterprise constitution guardrails.' }
        }
      }
    },
    {
      name: 'run_cli_generate',
      description: 'Generate contracts, DTO schemas, test fixtures, docker-compose, and agent prompts from Gherkin feature spec.',
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Path to Gherkin .feature file.' },
          config: { type: 'string', description: 'Optional path to gherkin-ai.config.json file.' }
        },
        required: ['feature']
      }
    },
    {
      name: 'run_cli_add',
      description: 'Inject contracts & AI agent prompts into an existing brownfield project target directory.',
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Path to Gherkin .feature file.' },
          target: { type: 'string', description: 'Target directory inside existing project.' }
        },
        required: ['feature', 'target']
      }
    },
    {
      name: 'run_cli_create',
      description: 'Create a Gherkin .feature specification non-interactively with feature name, actor, action, outcome, and scenarios.',
      inputSchema: {
        type: 'object',
        properties: {
          featureName: { type: 'string', description: 'Feature name/title.' },
          actor: { type: 'string', description: 'Feature actor (As a...).' },
          action: { type: 'string', description: 'Feature action (I want to...).' },
          outcome: { type: 'string', description: 'Feature outcome (So that...).' },
          scenarioName: { type: 'string', description: 'Main scenario title.' },
          output: { type: 'string', description: 'Destination path for created .feature file.' },
          target: { type: 'string', description: 'Optional target directory to auto-inject contracts.' }
        },
        required: ['featureName']
      }
    },
    {
      name: 'run_cli_login',
      description: 'Configure API credentials, tokens, and AI providers (OpenAI, Anthropic, Gemini, Ollama, custom) non-interactively.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Platform or agent auth token.' },
          user: { type: 'string', description: 'User or agent identifier/email.' },
          apiKey: { type: 'string', description: 'LLM API key.' },
          provider: { type: 'string', description: 'AI provider (openai, anthropic, gemini, ollama, azure-openai, custom).' },
          endpoint: { type: 'string', description: 'AI or server API endpoint URL.' },
          server: { type: 'string', description: 'Centralized audit or registry server URL.' }
        }
      }
    },
    {
      name: 'run_cli_audit',
      description: 'Query or clear feature execution audit trail inventory.',
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Filter audit records by feature spec or name.' },
          clear: { type: 'boolean', description: 'If true, clears audit trail history.' }
        }
      }
    },
    {
      name: 'run_cli_agent_log',
      description: 'Record or view actions executed by AI Agents during feature implementation.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Describe concrete action taken by AI Agent.' },
          feature: { type: 'string', description: 'Feature name or spec path.' },
          list: { type: 'boolean', description: 'If true, lists agent action walkthrough.' },
          clear: { type: 'boolean', description: 'If true, clears agent action logs.' }
        }
      }
    },
    {
      name: 'run_cli_implement',
      description: 'Generate AI Agent Master Implementation Prompt and context package for a feature.',
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Path to Gherkin .feature file.' },
          docker: { type: 'boolean', description: 'Include Docker container sandbox instructions in master prompt.' },
          compact: { type: 'boolean', description: 'Generate ultra-compact prompt for low-cost models.' }
        },
        required: ['feature']
      }
    }
  ];
}


// ---------------------------------------------------------------------------
// Tool Call Handlers
// ---------------------------------------------------------------------------

async function handleToolCall(id: number | string, name: string, args: any): Promise<void> {
  try {
    switch (name) {
      case 'run_cli_diff': {
        const { feature, target } = args;
        try {
          const { stdout, stderr } = await execAsync(`node bin/gherkin-ai.js diff --feature ${feature} --target ${target}`);
          sendJsonRpcResponse(id, {
            content: [{ type: 'text', text: stdout || stderr }]
          });
        } catch (e: any) {
          sendJsonRpcResponse(id, {
            content: [{ type: 'text', text: e.stdout || e.stderr || e.message }]
          });
        }
        break;
      }

      case 'run_cli_verify': {
        const autoFixFlag = args.autoFix ? '--auto-fix' : '';
        const commandFlag = args.command ? `--command "${args.command}"` : '';
        try {
          const { stdout, stderr } = await execAsync(`node bin/gherkin-ai.js verify ${autoFixFlag} ${commandFlag}`);
          sendJsonRpcResponse(id, {
            content: [{ type: 'text', text: stdout || stderr }]
          });
        } catch (e: any) {
          sendJsonRpcResponse(id, {
            content: [{ type: 'text', text: e.stdout || e.stderr || e.message }]
          });
        }
        break;
      }

      case 'run_cli_autopilot': {
        const requirement = args.requirement;
        try {
          const { stdout, stderr } = await execAsync(`node bin/gherkin-ai.js autopilot --requirement ${requirement}`);
          sendJsonRpcResponse(id, {
            content: [{ type: 'text', text: stdout || stderr }]
          });
        } catch (e: any) {
          sendJsonRpcResponse(id, {
            content: [{ type: 'text', text: e.stdout || e.stderr || e.message }]
          });
        }
        break;
      }

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
        const ir = buildSpecificationIR(parsed, args.featureFile as string);
        const output = generateContracts(parsed, ir, config);
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
        const riskCard = calculateDeliveryRisk();
        sendJsonRpcResponse(id, {
          content: [
            {
              type: 'text',
              text: `=== Deployment Risk Assessment ===\nRisk Level: ${riskCard.riskLevel}\nRisk Score: ${riskCard.overallRiskScore}\nBlast Radius: ${riskCard.blastRadius}\nTest Strength: ${riskCard.testStrength}\nSecurity Sensitivity: ${riskCard.securitySensitivity}\nRequires Human Approval: ${riskCard.requiresHumanApproval}\n\nFactors:\n${riskCard.factors.join('\n')}`
            }
          ]
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

      case 'ghk_governance_check': {
        const policyEngine = new AgentPolicyEngine(process.cwd());
        const hashBaseline = new SpecHashBaseline(process.cwd());
        const files = args.files || [];
        const policyEval = policyEngine.evaluateFileModifications(files);
        const driftEval = hashBaseline.verifyDrift(files);

        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({
            policy: policyEval,
            baselineDrift: driftEval
          }, null, 2) }]
        });
        break;
      }

      case 'ghk_impact_analysis': {
        const analyzer = new CrossServiceImpactAnalyzer();
        let ir = buildIR(parseGherkinText(args.gherkinText || 'Feature: Impact Analysis'), 'input.feature');
        const result = analyzer.analyzeImpact(ir, args.changedFiles || []);

        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        });
        break;
      }

      case 'run_cli_init': {
        await handleInitCommand({
          ...args,
          nonInteractive: true,
          yes: true
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Project initialized via MCP', config: loadConfig() }, null, 2) }]
        });
        break;
      }

      case 'run_cli_generate': {
        await handleGenerateCommand({
          ...args,
          nonInteractive: true,
          yes: true
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Contracts generated for ${args.feature}` }, null, 2) }]
        });
        break;
      }

      case 'run_cli_add': {
        await handleAddCommand({
          ...args,
          nonInteractive: true,
          yes: true
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Contracts added to target ${args.target}` }, null, 2) }]
        });
        break;
      }

      case 'run_cli_create': {
        await handleCreateCommand({
          ...args,
          nonInteractive: true,
          yes: true
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Feature spec created: ${args.featureName}` }, null, 2) }]
        });
        break;
      }

      case 'run_cli_login': {
        const authData = await handleLoginCommand({
          ...args,
          nonInteractive: true,
          yes: true
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Auth credentials saved', user: authData.user, provider: authData.provider }, null, 2) }]
        });
        break;
      }

      case 'run_cli_audit': {
        await handleAuditCommand({
          ...args,
          json: true
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Audit query executed' }, null, 2) }]
        });
        break;
      }

      case 'run_cli_agent_log': {
        await handleAgentLogCommand({
          ...args,
          json: true
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Agent log action executed' }, null, 2) }]
        });
        break;
      }

      case 'run_cli_implement': {
        await handleImplementCommand({
          ...args
        });
        sendJsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Master prompt generated for ${args.feature}` }, null, 2) }]
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

