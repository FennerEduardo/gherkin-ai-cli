/* ==========================================================================
   gherkin-ai-cli - GitHub Actions CI/CD

   CI (every push and pull request):
     spec-gates  ghk lint / validate / risk (PR) / converge report, CLI pinned
     backend     build + tests in the stack's toolchain image, then the runtime
                 integration suite against PostgreSQL and RabbitMQ services
     frontend    build + tests (when the project has one)
     image       docker build of the production image, Trivy scan of the
                 dependencies and the image, CycloneDX SBOM
   CD (config.deploy, pushes to main): one job per environment in order,
   gated by GitHub environment protection rules. OIDC to the cloud (no static
   keys), image pushed to the cloud registry, terraform plan + apply (or helm
   upgrade), then a smoke test of the readiness probe.
   Verified by scripts/golden-build.js (ci-github): actionlint + the
   github-workflows JSON schema.
   ========================================================================== */

import { CI_INTEGRATION_ENV, CI_SERVICES, GITHUB_ACTIONS as A, inWorkdir, PipelineSpec } from './pipeline-spec';

/** A GitHub expression: ${{ expr }} (kept out of TypeScript template interpolation). */
const e = (expr: string) => '${{ ' + expr + ' }}';
const q = (s: string) => JSON.stringify(s);
const indent = (text: string, n: number) => text.split('\n').map(l => (l ? ' '.repeat(n) + l : l)).join('\n');
const runBlock = (commands: string[]) => (commands.length === 1 ? ` ${commands[0]}` : ` |\n${indent(commands.join('\n'), 10)}`);

const VARIABLES: Record<string, string[]> = {
  aws: ['AWS_ROLE_ARN (role trusted for GitHub OIDC)', 'AWS_REGION', 'ECR_REPOSITORY'],
  gcp: ['GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_DEPLOY_SERVICE_ACCOUNT', 'GCP_PROJECT_ID', 'GCP_REGION', 'GCP_ARTIFACT_REPOSITORY'],
  azure: ['AZURE_CLIENT_ID (federated credential for this repository)', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'ACR_NAME']
};
const K8S_VARIABLES: Record<string, string[]> = {
  aws: ['EKS_CLUSTER'],
  gcp: ['GKE_CLUSTER', 'GKE_LOCATION'],
  azure: ['AKS_RESOURCE_GROUP', 'AKS_CLUSTER']
};

function cloudLogin(spec: PipelineSpec): string {
  switch (spec.deploy!.cloud) {
    case 'aws': return `      - uses: ${A.awsCredentials}
        with:
          role-to-assume: ${e('vars.AWS_ROLE_ARN')}
          aws-region: ${e('vars.AWS_REGION')}

      - id: registry
        uses: ${A.ecrLogin}

      - name: Build and push the image
        run: |
          IMAGE="${e('steps.registry.outputs.registry')}/${e('vars.ECR_REPOSITORY')}:${e('github.sha')}"
          docker build -t "$IMAGE" ${q(spec.workdir)}
          docker push "$IMAGE"
          echo "IMAGE=$IMAGE" >> "$GITHUB_ENV"`;
    case 'gcp': return `      - uses: ${A.gcpAuth}
        with:
          workload_identity_provider: ${e('vars.GCP_WORKLOAD_IDENTITY_PROVIDER')}
          service_account: ${e('vars.GCP_DEPLOY_SERVICE_ACCOUNT')}

      - uses: ${A.setupGcloud}

      - name: Build and push the image
        run: |
          REGISTRY="${e('vars.GCP_REGION')}-docker.pkg.dev"
          IMAGE="$REGISTRY/${e('vars.GCP_PROJECT_ID')}/${e('vars.GCP_ARTIFACT_REPOSITORY')}/${spec.name}:${e('github.sha')}"
          gcloud auth configure-docker "$REGISTRY" --quiet
          docker build -t "$IMAGE" ${q(spec.workdir)}
          docker push "$IMAGE"
          echo "IMAGE=$IMAGE" >> "$GITHUB_ENV"`;
    case 'azure': return `      - uses: ${A.azureLogin}
        with:
          client-id: ${e('vars.AZURE_CLIENT_ID')}
          tenant-id: ${e('vars.AZURE_TENANT_ID')}
          subscription-id: ${e('vars.AZURE_SUBSCRIPTION_ID')}

      - name: Build and push the image
        run: |
          IMAGE="${e('vars.ACR_NAME')}.azurecr.io/${spec.name}:${e('github.sha')}"
          az acr login --name "${e('vars.ACR_NAME')}"
          docker build -t "$IMAGE" ${q(spec.workdir)}
          docker push "$IMAGE"
          echo "IMAGE=$IMAGE" >> "$GITHUB_ENV"`;
  }
}

function terraformSteps(spec: PipelineSpec, env: string): string {
  const d = spec.deploy!;
  const ext = { aws: 's3', gcp: 'gcs', azure: 'azurerm' }[d.cloud];
  const dir = inWorkdir(spec, `deploy/terraform/${d.cloud}`);
  return `      - uses: ${A.setupTerraform}
        with:
          terraform_wrapper: false

      - name: Terraform plan and apply (${env})
        working-directory: ${dir}
        run: |
          terraform init -input=false -backend-config=environments/${env}.${ext}.tfbackend
          terraform plan -input=false -var-file=environments/${env}.tfvars -var "image=$IMAGE" -out=tfplan
          terraform apply -input=false tfplan
          echo "URL=$(terraform output -raw url)" >> "$GITHUB_ENV"`;
}

function helmSteps(spec: PipelineSpec, env: string): string {
  const d = spec.deploy!;
  const chart = inWorkdir(spec, `deploy/helm/${spec.name}`);
  const credentials = d.cloud === 'aws'
    ? `      - name: Cluster credentials
        run: aws eks update-kubeconfig --name "${e('vars.EKS_CLUSTER')}" --region "${e('vars.AWS_REGION')}"`
    : d.cloud === 'gcp'
      ? `      - uses: ${A.gkeCredentials}
        with:
          cluster_name: ${e('vars.GKE_CLUSTER')}
          location: ${e('vars.GKE_LOCATION')}`
      : `      - name: Cluster credentials
        run: az aks get-credentials --resource-group "${e('vars.AKS_RESOURCE_GROUP')}" --name "${e('vars.AKS_CLUSTER')}" --overwrite-existing`;
  return `${credentials}

      - uses: ${A.setupHelm}

      - name: Helm upgrade (${env})
        run: |
          helm upgrade --install ${spec.name} ${q(chart)} \\
            -f ${q(`${chart}/values-${env}.yaml`)} \\
            --set image.repository="$(echo "$IMAGE" | cut -d: -f1)" \\
            --set image.tag="${e('github.sha')}" \\
            --wait --atomic --timeout 10m`;
}

function deployJobs(spec: PipelineSpec): string {
  const d = spec.deploy!;
  const tf = d.compute !== 'kubernetes';
  return d.environments.map((env, i) => {
    const needs = i === 0 ? '[backend, image, spec-gates]' : `[deploy-${d.environments[i - 1]}]`;
    // compute "both": the pipeline deploys the managed containers (Terraform); the chart is for clusters deployed
    // by their own process. compute "kubernetes": the pipeline deploys the chart.
    const steps = [cloudLogin(spec), ...(tf ? [terraformSteps(spec, env)] : [helmSteps(spec, env)])];
    const smoke = tf ? `

      - name: Smoke test (readiness probe)
        run: |
          for _ in $(seq 1 30); do
            if curl -fsS "$URL${spec.health.ready}"; then exit 0; fi
            sleep 10
          done
          echo "The service did not become ready" && exit 1` : '';
    return `
  deploy-${env}:
    name: Deploy (${env})
    needs: ${needs}
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    # Protect the environment in the repository settings (required reviewers) to gate ${env}.
    environment: ${env}
    concurrency: deploy-${env}
    permissions:
      contents: read
      id-token: write
    env:
      ${d.cloud === 'azure' ? `ARM_USE_OIDC: "true"
      ARM_CLIENT_ID: ${e('vars.AZURE_CLIENT_ID')}
      ARM_TENANT_ID: ${e('vars.AZURE_TENANT_ID')}
      ARM_SUBSCRIPTION_ID: ${e('vars.AZURE_SUBSCRIPTION_ID')}` : `TF_IN_AUTOMATION: "1"`}
    steps:
      - uses: ${A.checkout}

${steps.join('\n\n')}${smoke}
`;
  }).join('');
}

export function renderGitHubWorkflow(spec: PipelineSpec): { filename: string; content: string } {
  const t = spec.backend;
  const integration = t?.integration?.length ? t.integration : [];
  const env = CI_INTEGRATION_ENV({ postgres: 'postgres', rabbitmq: 'rabbitmq' });
  const d = spec.deploy;
  const variables = d ? [...VARIABLES[d.cloud], ...(d.compute === 'kubernetes' ? K8S_VARIABLES[d.cloud] : [])] : [];

  const backendJob = t ? `
  backend:
    name: Backend build, tests and integration
    runs-on: ubuntu-latest
    container:
      image: ${t.image}${t.env ? `
      env:
${Object.entries(t.env).map(([k, v]) => `        ${k}: ${q(v)}`).join('\n')}` : ''}${integration.length ? `
    services:
      postgres:
        image: ${CI_SERVICES.postgres.image}
        env:
          POSTGRES_PASSWORD: ${CI_SERVICES.postgres.env.POSTGRES_PASSWORD}
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 20
      rabbitmq:
        image: ${CI_SERVICES.rabbitmq.image}
        env:
          RABBITMQ_DEFAULT_USER: ${CI_SERVICES.rabbitmq.env.RABBITMQ_DEFAULT_USER}
          RABBITMQ_DEFAULT_PASS: ${CI_SERVICES.rabbitmq.env.RABBITMQ_DEFAULT_PASS}
        options: >-
          --health-cmd "rabbitmq-diagnostics -q ping"
          --health-interval 10s --health-timeout 10s --health-retries 20` : ''}
    defaults:
      run:
        working-directory: ${spec.workdir}
    steps:
      - uses: ${A.checkout}

      - name: Build
        run:${runBlock(t.build)}

      - name: Tests
        run:${runBlock(t.test)}${integration.length ? `

      - name: Runtime integration suite (IT1-IT7 and the HTTP API)
        env:
${Object.entries(env).map(([k, v]) => `          ${k}: ${q(v)}`).join('\n')}
        run:${runBlock(integration)}` : ''}
` : '';

  const frontendJob = spec.frontend ? `
  frontend:
    name: Frontend build and tests
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${spec.frontend.dir}
    steps:
      - uses: ${A.checkout}

      - uses: ${A.setupNode}
        with:
          node-version: "24"

      - name: Build and test
        run: |
          npm install --no-audit --no-fund --loglevel=error
          npm run build
          npm test
` : '';

  const imageJob = spec.image ? `
  image:
    name: Production image, vulnerability scan and SBOM
    runs-on: ubuntu-latest
    steps:
      - uses: ${A.checkout}

      - name: Build the production image
        run: docker build -t ${spec.name}:${e('github.sha')} ${q(spec.workdir)}

      - name: Scan the dependencies
        uses: ${A.trivy}
        with:
          scan-type: fs
          scan-ref: ${q(spec.workdir)}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: "1"

      - name: Scan the image
        uses: ${A.trivy}
        with:
          scan-type: image
          image-ref: ${spec.name}:${e('github.sha')}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: "1"

      - name: SBOM (CycloneDX)
        uses: ${A.trivy}
        with:
          scan-type: image
          image-ref: ${spec.name}:${e('github.sha')}
          format: cyclonedx
          output: sbom.cdx.json

      - uses: ${A.uploadArtifact}
        with:
          name: sbom
          path: sbom.cdx.json
` : '';

  const content = `# ${spec.name} CI/CD, generated by gherkin-ai ${spec.ghkVersion}.${d ? `
# Deployment to ${d.cloud} (${d.compute}) on pushes to main, one environment after the other: ${d.environments.join(' -> ')}.
# Configure each GitHub environment (${d.environments.join(', ')}) with required reviewers and these variables:
${variables.map(v => `#   ${v}`).join('\n')}` : ''}
name: ${spec.name} CI/CD

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${spec.name}-${e('github.ref')}
  cancel-in-progress: ${e("github.event_name == 'pull_request'")}

env:
  # Pinned on purpose: a quality gate must not change behavior when a new version is published.
  GHK_VERSION: ${q(spec.ghkVersion)}
  GHK_NON_INTERACTIVE: "true"

jobs:
  spec-gates:
    name: Specification gates (gherkin-ai)
    runs-on: ubuntu-latest
    steps:
      - uses: ${A.checkout}
        with:
          fetch-depth: 0

      - uses: ${A.setupNode}
        with:
          node-version: "24"

      # Lint findings as annotations on the .feature lines, scores and delivery risk in the job summary.
      - name: Specification report (lint, convergence, delivery risk)
        env:
          BASE_REF: ${e('github.base_ref')}
        run: |
          args=()
          if [ -n "$BASE_REF" ]; then args=(--base "origin/$BASE_REF"); fi
          npx --yes "gherkin-ai@$GHK_VERSION" report --provider github "\${args[@]}" --fail-on CRITICAL

      - name: Validate architecture and deployment readiness
        run: npx --yes "gherkin-ai@$GHK_VERSION" validate

      - name: Convergence report
        continue-on-error: true
        run: npx --yes "gherkin-ai@$GHK_VERSION" converge --json > ghk-converge.json

      - uses: ${A.uploadArtifact}
        if: always()
        with:
          name: gherkin-ai-reports
          path: ghk-*.json
${backendJob}${frontendJob}${imageJob}${d && spec.image ? deployJobs(spec) : ''}`;

  return { filename: `.github/workflows/${spec.name}.yml`, content };
}
