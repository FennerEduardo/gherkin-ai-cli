import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

export interface Constitution {
  architecture: {
    style: string;
    required: string[];
    forbidden: string[];
  };
  security: {
    dataClassification: string;
    authProvider: string;
    secretsPolicy: string;
  };
  stack: {
    backend: string;
    frontend: string;
    database: string;
    testing: string;
  };
}

const defaultConstitutionYAML = `
# Gherkin AI Enterprise Constitution
# This file enforces strict guardrails for AI Agents to prevent hallucinated architecture.

architecture:
  style: modular-monolith
  required:
    - CQRS for complex domain logic
    - Ports and Adapters (Hexagonal) for external dependencies
  forbidden:
    - Direct database queries from Controllers
    - Global state mutations

security:
  dataClassification: RESTRICTED
  authProvider: OAuth2 + Keycloak
  secretsPolicy: DO NOT hardcode passwords. Use process.env variables.

stack:
  backend: nodejs-nestjs
  frontend: react-nextjs
  database: postgresql
  testing: vitest
`;

export function getConstitutionDir(): string {
  return path.join(process.cwd(), '.gherkin-ai');
}

export function generateConstitution(): void {
  const dir = getConstitutionDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const dest = path.join(dir, 'constitution.yaml');
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, defaultConstitutionYAML.trim());
  }
}

export function loadConstitution(): Constitution | null {
  const dest = path.join(getConstitutionDir(), 'constitution.yaml');
  if (fs.existsSync(dest)) {
    const content = fs.readFileSync(dest, 'utf8');
    return yaml.parse(content) as Constitution;
  }
  return null;
}
