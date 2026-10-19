/* ==========================================================================
   gherkin-ai-cli - Deployment readiness (ghk validate)

   Checks that keep a backend deployable as one image configured by the
   environment (docs/DEPLOYMENT.md, .ghe/deployment-context.md):
   - the production Dockerfile exists, runs as a non-root user and bakes in
     no secret;
   - .env.example documents the variables the service reads;
   - the deployment code (deploy/**) contains no hardcoded secret;
   - with config.deploy, the deployment code has been generated.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { GherkinAIConfig } from '../config';
import { deploymentContext, requiredLocalVariables } from '../../generators/deploy/context';
import { deployConfig } from '../../generators/deploy/service-spec';

export interface DeploymentReadinessResult {
  checked: boolean;
  errors: string[];
  warnings: string[];
}

const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|CONNECTION_STRING)/i;
/** A quoted literal assigned to a secret-looking key in HCL / YAML (interpolations and placeholders are fine). */
const HARDCODED_IN_DEPLOY = /^\s*"?([A-Za-z0-9_.-]*(password|secret|token|api_key|apikey|access_key)[A-Za-z0-9_.-]*)"?\s*[:=]\s*"([^"$<{}]{6,})"/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.terraform' || entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function validateDeploymentReadiness(config: GherkinAIConfig, outputDir: string): DeploymentReadinessResult {
  const result: DeploymentReadinessResult = { checked: false, errors: [], warnings: [] };
  const ctx = deploymentContext(config);
  if (!ctx) return result;
  result.checked = true;

  const dockerfile = path.join(outputDir, 'Dockerfile');
  if (!fs.existsSync(dockerfile)) {
    result.warnings.push('No production Dockerfile: run "ghk generate" (the image is what every cloud target deploys).');
  } else {
    const lines = fs.readFileSync(dockerfile, 'utf8').split(/\r?\n/);
    const users = lines.filter(l => /^\s*USER\s+/i.test(l)).map(l => l.trim().split(/\s+/)[1]);
    const lastUser = users[users.length - 1];
    if (!lastUser || /^(root|0)(:|$)/.test(lastUser)) {
      result.warnings.push('Dockerfile: the final image should run as a non-root USER.');
    }
    for (const line of lines) {
      const env = line.match(/^\s*(ENV|ARG)\s+(.*)$/i);
      if (!env) continue;
      for (const pair of env[2].split(/\s+/)) {
        const [key, value] = pair.split('=');
        if (key && value && SECRET_NAME.test(key) && !/^\$/.test(value)) {
          result.errors.push(`Dockerfile: ${env[1].toUpperCase()} ${key} bakes a secret into the image; inject it from the platform secret manager at run time.`);
        }
      }
    }
  }

  const envExample = path.join(outputDir, '.env.example');
  if (fs.existsSync(envExample)) {
    const documented = new Set(fs.readFileSync(envExample, 'utf8').split(/\r?\n/).map(l => l.replace(/^#\s*/, '').split('=')[0].trim()));
    const missing = requiredLocalVariables(config).filter(v => !documented.has(v));
    if (missing.length) result.warnings.push(`.env.example does not document: ${missing.join(', ')}.`);
  } else {
    result.warnings.push('.env.example is missing: document every environment variable the service reads.');
  }

  const deployDir = path.join(outputDir, 'deploy');
  if (deployConfig(config) && !fs.existsSync(deployDir)) {
    result.warnings.push('config.deploy is set but deploy/ is missing: run "ghk generate".');
  }
  for (const file of walk(deployDir)) {
    if (!/\.(tf|tfvars|ya?ml|json)$/.test(file)) continue;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = line.match(HARDCODED_IN_DEPLOY);
      if (m) result.errors.push(`${path.relative(outputDir, file).split(path.sep).join('/')}:${i + 1}: "${m[1]}" has a hardcoded value; use a generated secret or a sensitive variable.`);
    });
  }
  return result;
}
