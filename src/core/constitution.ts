import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

// ---------------------------------------------------------------------------
// Enhanced Constitution Schema
// ---------------------------------------------------------------------------

export interface ConstitutionArchitecture {
  style: string;
  required: string[];
  forbidden: string[];
  layers?: string[];
}

export interface ConstitutionSecurity {
  dataClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  authProvider: string;
  secretsPolicy: string;
  piiDetection?: boolean;
  allowedLLMProviders?: string[];
  forbiddenLLMProviders?: string[];
}

export interface ConstitutionStack {
  backend: string;
  frontend: string;
  database: string;
  testing: string;
  cloud?: string;
  messaging?: string;
  packageManager?: string;
}

export interface ConstitutionPolicies {
  codeReview: {
    required: boolean;
    minReviewers?: number;
  };
  testing: {
    unitCoverageTarget?: number;
    e2eRequired?: boolean;
    contractTestsRequired?: boolean;
  };
  deployment: {
    ciRequired?: boolean;
    dryRunDefault?: boolean;
    humanApprovalRequired?: boolean;
  };
  agents?: {
    [roleName: string]: {
      permissions: {
        read: string[];
        write: string[];
      };
    };
  };
}

export interface ConstitutionCompliance {
  frameworks?: string[];       // e.g., ['SOX', 'PCI-DSS', 'HIPAA', 'GDPR']
  auditTrail?: boolean;
  dataRetention?: string;
}

export interface Constitution {
  // Legacy fields (backward compatible)
  architecture: ConstitutionArchitecture;
  security: ConstitutionSecurity;
  stack: ConstitutionStack;

  // New enhanced fields
  organization?: {
    name: string;
    contactEmail?: string;
  };
  policies?: ConstitutionPolicies;
  compliance?: ConstitutionCompliance;
  constraints?: {
    level: 'must' | 'should' | 'may' | 'must-not';
    description: string;
    category: string;
  }[];
}

// ---------------------------------------------------------------------------
// Default Constitution YAML (Enhanced)
// ---------------------------------------------------------------------------

const defaultConstitutionYAML = `
# Gherkin AI Enterprise Constitution
# This file enforces strict guardrails for AI Agents to prevent hallucinated architecture.
# Every decision here reduces the LLM's solution space to your organization's standards.

organization:
  name: my-organization

architecture:
  style: modular-monolith
  required:
    - CQRS for complex domain logic
    - Ports and Adapters (Hexagonal) for external dependencies
  forbidden:
    - Direct database queries from Controllers
    - Global state mutations
    - Circular dependencies between modules
  layers:
    - domain
    - application
    - infrastructure
    - presentation

security:
  dataClassification: RESTRICTED
  authProvider: OAuth2 + Keycloak
  secretsPolicy: DO NOT hardcode passwords. Use process.env variables.
  piiDetection: true
  allowedLLMProviders:
    - openai
    - anthropic
    - ollama
  forbiddenLLMProviders:
    - public-free-models

stack:
  backend: nodejs-nestjs
  frontend: react-nextjs
  database: postgresql
  testing: vitest
  cloud: aws
  messaging: rabbitmq
  packageManager: npm

policies:
  codeReview:
    required: true
    minReviewers: 1
  testing:
    unitCoverageTarget: 80
    e2eRequired: true
    contractTestsRequired: true
  deployment:
    ciRequired: true
    dryRunDefault: true
    humanApprovalRequired: true
  agents:
    domain:
      permissions:
        read:
          - specs/**
          - docs/domain/**
        write:
          - src/domain/**
    backend:
      permissions:
        read:
          - specs/**
          - contracts/**
        write:
          - src/api/**
          - src/application/**
    qa:
      permissions:
        read:
          - specs/**
          - src/**
        write:
          - tests/**

compliance:
  frameworks: []
  auditTrail: true
  dataRetention: "7 years"

constraints:
  - level: must
    description: All API endpoints must require authentication
    category: security
  - level: must-not
    description: Generated code must not contain hardcoded secrets
    category: security
  - level: should
    description: Domain logic should be free of infrastructure concerns
    category: architecture
`;

// ---------------------------------------------------------------------------
// Directory Structure
// ---------------------------------------------------------------------------

export function getConstitutionDir(): string {
  return path.join(process.cwd(), '.gherkin-ai');
}

export function generateConstitution(options?: { enterprise?: boolean }): void {
  const dir = getConstitutionDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create subdirectories
  const subdirs = ['policies', 'agents', 'templates', 'evaluations'];
  for (const sub of subdirs) {
    const subPath = path.join(dir, sub);
    if (!fs.existsSync(subPath)) {
      fs.mkdirSync(subPath, { recursive: true });
    }
  }

  // Write constitution.yaml
  const constitutionPath = path.join(dir, 'constitution.yaml');
  if (!fs.existsSync(constitutionPath)) {
    fs.writeFileSync(constitutionPath, defaultConstitutionYAML.trim());
  }

  // Write default agent configs
  const agentConfigs: Record<string, string> = {
    'domain-agent.yaml': `# Domain Agent Configuration
name: domain-agent
role: Domain Expert
description: Responsible for domain model integrity and business rules.
permissions:
  read:
    - specs/**
    - docs/domain/**
  write:
    - src/domain/**
focus:
  - Entity modeling
  - Value objects
  - Domain events
  - Business invariants
`,
    'backend-agent.yaml': `# Backend Agent Configuration
name: backend-agent
role: Backend Engineer
description: Responsible for API implementation and application services.
permissions:
  read:
    - specs/**
    - contracts/**
    - src/domain/**
  write:
    - src/api/**
    - src/application/**
    - src/infrastructure/**
focus:
  - API controllers
  - Application services
  - Database repositories
  - Integration adapters
`,
    'qa-agent.yaml': `# QA Agent Configuration
name: qa-agent
role: QA Engineer
description: Responsible for test coverage and quality assurance.
permissions:
  read:
    - specs/**
    - src/**
    - contracts/**
  write:
    - tests/**
    - e2e/**
focus:
  - Unit tests
  - Integration tests
  - E2E tests
  - Contract tests
`,
  };

  for (const [filename, content] of Object.entries(agentConfigs)) {
    const agentPath = path.join(dir, 'agents', filename);
    if (!fs.existsSync(agentPath)) {
      fs.writeFileSync(agentPath, content);
    }
  }

  // Write default policy files
  const policyFiles: Record<string, string> = {
    'security-policy.md': `# Security Policy

## Authentication
- All API endpoints must require authentication unless explicitly marked as public.
- Use the organization's designated auth provider (see constitution.yaml).

## Secret Management
- Never hardcode secrets, API keys, or passwords in source code.
- Use environment variables or a secrets manager.

## Data Classification
- Follow the data classification level defined in constitution.yaml.
- PII must be encrypted at rest and in transit.
`,
    'architecture-policy.md': `# Architecture Policy

## Layer Boundaries
- Domain layer must not depend on Infrastructure.
- Application layer orchestrates domain logic.
- Infrastructure adapts external systems.
- Presentation handles user interface concerns.

## Prohibited Patterns
- No direct database access from controllers.
- No business logic in infrastructure adapters.
- No circular dependencies between modules.
`,
  };

  for (const [filename, content] of Object.entries(policyFiles)) {
    const policyPath = path.join(dir, 'policies', filename);
    if (!fs.existsSync(policyPath)) {
      fs.writeFileSync(policyPath, content);
    }
  }
}

// ---------------------------------------------------------------------------
// Constitution Loader (backward compatible)
// ---------------------------------------------------------------------------

export function loadConstitution(targetDir: string = process.cwd()): Constitution | null {
  const newPath = path.join(targetDir, '.gherkin-ai', 'constitution.yaml');
  const legacyPath = path.join(targetDir, '.ghe', 'constitution.yaml');
  const oldPath = path.join(getConstitutionDir(), 'constitution.yaml');

  const filePath = fs.existsSync(newPath) ? newPath :
                   fs.existsSync(legacyPath) ? legacyPath :
                   fs.existsSync(oldPath) ? oldPath : null;

  if (!filePath) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.parse(content);

    // Normalize to new schema with backward compatibility
    return {
      architecture: {
        style: parsed.architecture?.style || 'hexagonal',
        required: parsed.architecture?.required || [],
        forbidden: parsed.architecture?.forbidden || [],
        layers: parsed.architecture?.layers,
      },
      security: {
        dataClassification: parsed.security?.dataClassification || 'INTERNAL',
        authProvider: parsed.security?.authProvider || '',
        secretsPolicy: parsed.security?.secretsPolicy || '',
        piiDetection: parsed.security?.piiDetection,
        allowedLLMProviders: parsed.security?.allowedLLMProviders,
        forbiddenLLMProviders: parsed.security?.forbiddenLLMProviders,
      },
      stack: {
        backend: parsed.stack?.backend || '',
        frontend: parsed.stack?.frontend || '',
        database: parsed.stack?.database || '',
        testing: parsed.stack?.testing || '',
        cloud: parsed.stack?.cloud,
        messaging: parsed.stack?.messaging,
        packageManager: parsed.stack?.packageManager,
      },
      organization: parsed.organization,
      policies: parsed.policies,
      compliance: parsed.compliance,
      constraints: parsed.constraints,
    } as Constitution;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent Permission Resolver
// ---------------------------------------------------------------------------

export function getAgentPermissions(
  agentRole: string,
  constitution?: Constitution | null
): { read: string[]; write: string[] } {
  const defaultPerms = { read: ['**'], write: ['**'] };

  if (!constitution?.policies?.agents) return defaultPerms;

  const agentConfig = constitution.policies.agents[agentRole];
  if (!agentConfig) return defaultPerms;

  return agentConfig.permissions || defaultPerms;
}

// ---------------------------------------------------------------------------
// Constraint Level Helpers
// ---------------------------------------------------------------------------

export function getConstraintsByLevel(
  constitution: Constitution | null,
  level: 'must' | 'should' | 'may' | 'must-not'
): { description: string; category: string }[] {
  if (!constitution?.constraints) return [];
  return constitution.constraints.filter(c => c.level === level);
}

export function isLLMProviderAllowed(
  provider: string,
  constitution: Constitution | null
): boolean {
  if (!constitution?.security) return true;

  if (constitution.security.forbiddenLLMProviders?.includes(provider)) return false;
  if (constitution.security.allowedLLMProviders && constitution.security.allowedLLMProviders.length > 0) {
    return constitution.security.allowedLLMProviders.includes(provider);
  }

  return true;
}
