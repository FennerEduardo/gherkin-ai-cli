/* ==========================================================================
   gherkin-ai-cli - Pinned versions of the generated deployment code.

   Bump them here; the golden builds (terraform-aws, terraform-gcp, terraform-azure,
   helm; images in scripts/golden-stacks.js) run terraform validate / helm lint
   on every CI build.
   ========================================================================== */

export const TERRAFORM_REQUIRED = '>= 1.10';

/** OpenTelemetry collector sidecars: ADOT on AWS (X-Ray, CloudWatch), contrib elsewhere (Cloud Trace, Azure Monitor). */
export const COLLECTOR_IMAGES = {
  aws: 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0',
  contrib: 'otel/opentelemetry-collector-contrib:0.163.1'
} as const;

/** Provider constraints (~> major.minor: patch and minor updates within the major). */
export const PROVIDERS = {
  aws: '~> 6.69',
  google: '~> 8.7',
  azurerm: '~> 5.10',
  random: '~> 3.9'
} as const;

