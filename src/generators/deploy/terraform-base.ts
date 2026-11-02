/* ==========================================================================
   gherkin-ai-cli - Shared base stack for the services of a monorepo
   (deploy.base; LMS P-06: 9 services meant 9 RDS instances and 9 brokers)

   The base module (deploy.base.dir/aws) owns the data plane once:
     - one RDS for PostgreSQL instance, with one database and one role per
       service (created by the idempotent `bootstrap_sql` output);
     - one Amazon MQ for RabbitMQ broker when a service uses RabbitMQ;
     - a "clients" security group: what may reach the database and broker.
   Each service module keeps its compute, secrets and IAM, but takes its
   DATABASE_URL and AMQP_URL from the base's remote state and joins the
   clients group, instead of creating its own database and broker.

   AWS since 3.2.2; Google Cloud (Cloud SQL) and Azure (Flexible Server and
   a shared Service Bus namespace) since 3.3.0 (X-09b).
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { GherkinAIConfig } from '../../core/config';
import { ConfigError } from '../../core/errors';
import { findGhkProjects } from '../../core/workspace-projects';
import { toKebab } from '../../utils/naming';
import { dbIdentifier, hattrs, hlist, hstr } from './hcl';
import { cloudBroker, type DeployConfig, type ServiceSpec } from './service-spec';
import type { TerraformFile } from './terraform-aws';
import { PROVIDERS, TERRAFORM_REQUIRED } from './terraform-versions';

export const block = (kind: string, a: string, b?: string) => new RegExp(`${kind} "${a}"${b ? ` "${b}"` : ''} \\{[\\s\\S]*?\\n\\}\\n\\n?`, 'g');

/** Re-renders `key = value` lines (a tfvars file) without some keys and with others added, aligned as terraform fmt does. */
export function retfvars(content: string, drop: RegExp, add: [string, string][]): string {
  const comments = content.split('\n').filter(l => l.startsWith('#'));
  const entries = content.split('\n').map(l => l.match(/^([a-z_]+)\s+= (.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m))
    .filter(m => !drop.test(m[1])).map(m => [m[1], m[2]] as [string, string]);
  return `${hattrs([...entries, ...add], 0)}\n${comments.length ? `${comments.join('\n')}\n` : ''}`;
}

export interface BaseService {
  name: string;
  /** AWS: the service uses RabbitMQ (Amazon MQ). */
  rabbitmq: boolean;
  /** Azure: the service uses Service Bus. */
  servicebus?: boolean;
}

/** The service module, reading its database and broker from the base stack. */
export function applySharedBaseAws(files: TerraformFile[], spec: ServiceSpec, deploy: DeployConfig): TerraformFile[] {
  const dir = 'deploy/terraform/aws';
  const remote = 'data.terraform_remote_state.base.outputs';
  return files.filter(f => f.filename !== `${dir}/database.tf` && f.filename !== `${dir}/broker.tf`).map(f => {
    const rel = f.filename.slice(dir.length + 1);
    let content = f.content;
    if (rel === 'variables.tf') {
      content = content.replace(/variable "(db_[a-z_]+|mq_[a-z_]+)" \{[\s\S]*?\n\}\n/g, '').replace(/\n{3,}/g, '\n\n') + `
variable "base_state_bucket" {
  description = "S3 bucket of the shared base stack's Terraform state (deploy.base)."
  type        = string
}

variable "base_state_key" {
  description = "Key of the base stack's state for this environment (for example base/dev.tfstate)."
  type        = string
}
`;
    } else if (rel === 'network.tf') {
      content = content.replace(block('resource', 'aws_security_group', 'database'), '').replace(block('resource', 'aws_security_group', 'broker'), '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
    } else if (rel === 'secrets.tf') {
      content = content
        .replace(/"postgres:\/\/\$\{aws_db_instance\.this\.username\}[^"]*"/, `${remote}.database_urls[${hstr(spec.name)}]`)
        .split('"amqps://app:${random_password.mq.result}@${trimprefix(aws_mq_broker.this.instances[0].endpoints[0], "amqps://")}"').join(`${remote}.amqp_url`);
    } else if (rel === 'service.tf' || rel === 'iam.tf') {
      content = content.replace(/\[aws_security_group\.service\.id\]/g, `[aws_security_group.service.id, ${remote}.clients_security_group_id]`);
    } else if (rel === 'outputs.tf') {
      content = content.replace(block('output', 'database_endpoint'), '').replace(block('output', 'broker_endpoint'), '').replace(/\n+$/, '\n');
    } else if (/^environments\/.+\.tfvars$/.test(rel)) {
      const env = path.basename(rel, '.tfvars');
      content = retfvars(content, /^(db_|mq_)/, [['base_state_bucket', hstr('<base-state-bucket>')], ['base_state_key', hstr(`base/${env}.tfstate`)]]);
    }
    return { ...f, content };
  }).concat({
    filename: `${dir}/base.tf`,
    content: `# The shared base stack (deploy.base): database and broker of every service of the repository.
data "terraform_remote_state" "base" {
  backend = "s3"

  config = {
    bucket = var.base_state_bucket
    key    = var.base_state_key
    region = var.region
  }
}
`
  });
}

/** The services of the repository that share this base directory (their gherkin-ai.config.json deploy.base.dir). */
export function baseServices(config: GherkinAIConfig, cwd = process.cwd()): BaseService[] {
  const baseDir = path.resolve(cwd, config.deploy!.base!.dir);
  // The services live under the common ancestor of this project and the base directory (the repository).
  const a = path.resolve(cwd).split(path.sep);
  const b = baseDir.split(path.sep);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const root = a.slice(0, i).join(path.sep) || path.sep;
  const services = new Map<string, BaseService>();
  for (const project of [cwd, ...findGhkProjects(root)]) {
    let c: GherkinAIConfig;
    try { c = JSON.parse(fs.readFileSync(path.join(project, 'gherkin-ai.config.json'), 'utf8')); } catch { continue; }
    if (!c.deploy?.base?.dir || path.resolve(project, c.deploy.base.dir) !== baseDir || c.deploy.cloud !== config.deploy?.cloud) continue;
    const name = toKebab(c.projectName || path.basename(project));
    services.set(name, { name, rabbitmq: cloudBroker(c, 'aws') === 'rabbitmq', servicebus: cloudBroker(c, 'azure') === 'servicebus' });
  }
  return [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The base module (AWS): one database instance, one broker, a role and a database per service. */
export function renderBaseAws(services: BaseService[], deploy: DeployConfig, dir: string): TerraformFile[] {
  const mq = services.some(s => s.rabbitmq);
  const ids = Object.fromEntries(services.map(s => [s.name, dbIdentifier(s.name)]));

  const versions = `terraform {
  required_version = ${hstr(TERRAFORM_REQUIRED)}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ${hstr(PROVIDERS.aws)}
    }
    random = {
      source  = "hashicorp/random"
      version = ${hstr(PROVIDERS.random)}
    }
  }

  # One state per environment: terraform init -backend-config=environments/<env>.s3.tfbackend
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}
`;

  const variables = `variable "name" {
  description = "Prefix of the base resources."
  type        = string
  default     = "platform"
}

variable "environment" {
  description = "Environment name (${deploy.environments.join(', ')})."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = ${hstr(deploy.region)}
}

variable "vpc_id" {
  description = "VPC of the services."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subnets of the database and the broker (two or more availability zones)."
  type        = list(string)
}

variable "db_instance_class" {
  description = "RDS instance class shared by every service."
  type        = string
  default     = "db.t4g.small"
}

variable "db_engine_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "17"
}

variable "db_allocated_storage" {
  description = "Initial storage (GiB); it grows up to four times this value."
  type        = number
  default     = 20
}

variable "db_multi_az" {
  description = "Standby replica in another availability zone."
  type        = bool
  default     = false
}

variable "db_require_tls" {
  description = "Reject unencrypted database connections (rds.force_ssl)."
  type        = bool
  default     = true
}
${mq ? `
variable "mq_instance_type" {
  description = "Amazon MQ broker instance type shared by every service."
  type        = string
  default     = "mq.m7g.medium"
}

variable "mq_engine_version" {
  description = "RabbitMQ engine version of Amazon MQ."
  type        = string
  default     = "3.13"
}

variable "mq_deployment_mode" {
  description = "SINGLE_INSTANCE or CLUSTER_MULTI_AZ."
  type        = string
  default     = "SINGLE_INSTANCE"
}
` : ''}
variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}
`;

  const main = `locals {
  name = "\${var.name}-\${var.environment}"
  prod = var.environment == "prod"

  tags = merge({
    stack       = "base"
    environment = var.environment
    managed-by  = "terraform"
  }, var.tags)

  # Service (kebab-case name) -> database and role name.
  services = ${Object.keys(ids).length ? `{\n${hattrs(Object.entries(ids).map(([k, v]) => [hstr(k), hstr(v)]), 4)}\n  }` : '{}'}
}
`;

  const network = `# Every service module adds this group to its tasks or machine (deploy.base).
resource "aws_security_group" "clients" {
  name        = "\${local.name}-clients"
  description = "Services of \${local.name} allowed to reach the database and the broker"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "database" {
  name        = "\${local.name}-database"
  description = "PostgreSQL of \${local.name}"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from the services"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.clients.id]
  }
}
${mq ? `
resource "aws_security_group" "broker" {
  name        = "\${local.name}-broker"
  description = "Amazon MQ of \${local.name}"
  vpc_id      = var.vpc_id

  ingress {
    description     = "AMQPS from the services"
    from_port       = 5671
    to_port         = 5671
    protocol        = "tcp"
    security_groups = [aws_security_group.clients.id]
  }
}
` : ''}`;

  const database = `resource "random_password" "master" {
  length  = 32
  special = false
}

# One password per service role.
resource "random_password" "service" {
  for_each = local.services

  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = local.name
  family = "postgres\${var.db_engine_version}"

  parameter {
    name  = "rds.force_ssl"
    value = var.db_require_tls ? "1" : "0"
  }
}

resource "aws_db_instance" "this" {
${hattrs([
    ['identifier', 'local.name'],
    ['engine', '"postgres"'],
    ['engine_version', 'var.db_engine_version'],
    ['instance_class', 'var.db_instance_class'],
    ['allocated_storage', 'var.db_allocated_storage'],
    ['max_allocated_storage', 'var.db_allocated_storage * 4'],
    ['storage_encrypted', 'true'],
    ['username', '"platform_admin"'],
    ['password', 'random_password.master.result'],
    ['db_subnet_group_name', 'aws_db_subnet_group.this.name'],
    ['parameter_group_name', 'aws_db_parameter_group.this.name'],
    ['vpc_security_group_ids', '[aws_security_group.database.id]'],
    ['multi_az', 'var.db_multi_az'],
    ['publicly_accessible', 'false'],
    ['backup_retention_period', 'local.prod ? 14 : 1'],
    ['deletion_protection', 'local.prod'],
    ['skip_final_snapshot', '!local.prod'],
    ['final_snapshot_identifier', 'local.prod ? "${local.name}-final" : null'],
    ['auto_minor_version_upgrade', 'true'],
    ['apply_immediately', '!local.prod']
  ], 2)}
}
`;

  const broker = `resource "random_password" "mq" {
  length  = 32
  special = false
}

resource "aws_mq_broker" "this" {
  broker_name                = local.name
  engine_type                = "RabbitMQ"
  engine_version             = var.mq_engine_version
  host_instance_type         = var.mq_instance_type
  deployment_mode            = var.mq_deployment_mode
  subnet_ids                 = var.mq_deployment_mode == "SINGLE_INSTANCE" ? [var.private_subnet_ids[0]] : var.private_subnet_ids
  security_groups            = [aws_security_group.broker.id]
  publicly_accessible        = false
  auto_minor_version_upgrade = true
  apply_immediately          = !local.prod

  user {
    username = "app"
    password = random_password.mq.result
  }

  logs {
    general = true
  }
}
`;

  const outputs = `output "clients_security_group_id" {
  description = "Security group the service modules attach to reach the database and the broker."
  value       = aws_security_group.clients.id
}

output "database_urls" {
  description = "DATABASE_URL of each service: its own role and database on the shared instance."
  sensitive   = true
  value = { for service, id in local.services :
    service => "postgres://\${id}:\${random_password.service[service].result}@\${aws_db_instance.this.address}:\${aws_db_instance.this.port}/\${id}?sslmode=require"
  }
}

output "amqp_url" {
  description = "AMQP URL of the shared broker (each service declares its own exchange and queues)."
  sensitive   = true
  value       = ${mq ? '"amqps://app:${random_password.mq.result}@${trimprefix(aws_mq_broker.this.instances[0].endpoints[0], "amqps://")}"' : 'null'}
}

output "database_endpoint" {
  value = aws_db_instance.this.address
}

output "master_url" {
  description = "Administrator connection, for the bootstrap only."
  sensitive   = true
  value       = "postgres://platform_admin:\${random_password.master.result}@\${aws_db_instance.this.address}:\${aws_db_instance.this.port}/postgres?sslmode=require"
}

# Run once after apply, and again after adding a service, from a host inside the VPC (psql):
#   terraform output -raw bootstrap_sql | psql "$(terraform output -raw master_url)"
output "bootstrap_sql" {
  description = "Idempotent SQL that creates each service's role and database (rerun to rotate their passwords)."
  sensitive   = true
  value = join("\\n", flatten([for service, id in local.services : [
    format("DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s LOGIN PASSWORD '%s'; ELSE ALTER ROLE %s PASSWORD '%s'; END IF; END$$;", id, id, random_password.service[service].result, id, random_password.service[service].result),
    format("GRANT %s TO platform_admin;", id),
    format("SELECT 'CREATE DATABASE %s OWNER %s' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '%s')\\\\gexec", id, id, id),
    format("REVOKE ALL ON DATABASE %s FROM PUBLIC;", id)
  ]]))
}
`;

  const tfvars = deploy.environments.flatMap(env => {
    const prod = env === 'prod';
    return [
      {
        filename: `${dir}/environments/${env}.tfvars`,
        content: `${hattrs([
          ['environment', hstr(env)],
          ['region', hstr(deploy.region)],
          ['vpc_id', hstr('vpc-<id>')],
          ['private_subnet_ids', hlist(['subnet-<private-a>', 'subnet-<private-b>'])],
          ['db_instance_class', hstr(prod ? 'db.m7g.large' : 'db.t4g.small')],
          ['db_multi_az', prod ? 'true' : 'false'],
          ...(mq ? [['mq_instance_type', hstr(prod ? 'mq.m7g.medium' : 'mq.t3.micro')], ['mq_deployment_mode', hstr(prod ? 'CLUSTER_MULTI_AZ' : 'SINGLE_INSTANCE')]] as [string, string][] : [])
        ], 0)}\n`
      },
      {
        filename: `${dir}/environments/${env}.s3.tfbackend`,
        content: `${hattrs([['bucket', hstr('<base-state-bucket>')], ['key', hstr(`base/${env}.tfstate`)], ['region', hstr(deploy.region)], ['use_lockfile', 'true'], ['encrypt', 'true']], 0)}\n`
      }
    ];
  });

  const readme = `# Shared base stack (AWS)

Generated by gherkin-ai for the services whose \`gherkin-ai.config.json\` sets \`deploy.base.dir\` to this directory: ${services.map(s => `\`${s.name}\``).join(', ') || '(none yet)'}. It is rewritten by \`ghk generate\` in any of them.

1. Apply this stack first, once per environment:

   \`\`\`bash
   terraform init -backend-config=environments/dev.s3.tfbackend
   terraform apply -var-file=environments/dev.tfvars
   \`\`\`

2. Create the roles and databases of the services (idempotent; rerun after adding a service). From a host inside the VPC, such as a service machine through \`aws ssm start-session\`:

   \`\`\`bash
   terraform output -raw bootstrap_sql | docker run -i --rm postgres:17-alpine psql "$(terraform output -raw master_url)"
   \`\`\`

3. Apply each service module with \`base_state_bucket\` and \`base_state_key\` pointing at this stack's state.

Each service has its own role and database on the shared instance (no access to the others), and its own exchange and queues on the shared broker.
`;

  return [
    { filename: `${dir}/versions.tf`, content: versions },
    { filename: `${dir}/variables.tf`, content: variables },
    { filename: `${dir}/main.tf`, content: main },
    { filename: `${dir}/network.tf`, content: network },
    { filename: `${dir}/database.tf`, content: database },
    ...(mq ? [{ filename: `${dir}/broker.tf`, content: broker }] : []),
    { filename: `${dir}/outputs.tf`, content: outputs },
    ...tfvars,
    { filename: `${dir}/README.md`, content: readme }
  ];
}

/** deploy.base: the service module reads the base stack, and the base module is (re)written for every sharing service. */
export function sharedBaseFiles(config: GherkinAIConfig, spec: ServiceSpec, deploy: DeployConfig, serviceFiles: TerraformFile[]): TerraformFile[] {
  if (!['aws', 'gcp', 'azure'].includes(deploy.cloud)) {
    throw new ConfigError(`deploy.base is not generated for deploy.cloud "${deploy.cloud}".`, { hint: 'Use aws, gcp or azure, or remove deploy.base to give the service its own database and broker.' });
  }
  const cwd = process.cwd();
  const outDir = path.resolve(cwd, config.outputDir || '.');
  const baseDir = path.relative(outDir, path.resolve(cwd, config.deploy!.base!.dir, deploy.cloud)).split(path.sep).join('/');
  const services = baseServices(config, cwd);
  if (deploy.cloud === 'gcp') return [...applySharedBaseGcp(serviceFiles, spec, deploy), ...renderBaseGcp(services, deploy, baseDir)];
  if (deploy.cloud === 'azure') return [...applySharedBaseAzure(serviceFiles, spec, deploy), ...renderBaseAzure(services, deploy, baseDir)];
  return [...applySharedBaseAws(serviceFiles, spec, deploy), ...renderBaseAws(services, deploy, baseDir)];
}

// ---------------------------------------------------------------------------
// Google Cloud (X-09b, 3.3.0): one Cloud SQL instance with a user and a database per service. Pub/Sub has no
// instance to share (each service keeps its topics and subscriptions in its own module).
// ---------------------------------------------------------------------------

/** Drops `variable "<name>"` blocks. */
export const withoutVariables = (content: string, names: RegExp) =>
  content.replace(/variable "([a-z_]+)" \{[\s\S]*?\n\}\n/g, (b, name: string) => (names.test(name) ? '' : b)).replace(/\n{3,}/g, '\n\n');

/** The service module (Cloud Run or Compute Engine), reading its DATABASE_URL from the base stack. */
export function applySharedBaseGcp(files: TerraformFile[], spec: ServiceSpec, deploy: DeployConfig): TerraformFile[] {
  const dir = 'deploy/terraform/gcp';
  const remote = 'data.terraform_remote_state.base.outputs';
  const dbVars = /^(db_tier|db_version|db_require_tls|create_private_service_access)$/;
  return files.filter(f => f.filename !== `${dir}/database.tf`).map(f => {
    if (!f.filename.startsWith(`${dir}/`)) return f;
    const rel = f.filename.slice(dir.length + 1);
    let content = f.content
      .replace(/"postgres:\/\/\$\{google_sql_user\.app\.name\}[^"]*"/g, `${remote}.database_urls[${hstr(spec.name)}]`)
      .replace(/google_sql_database_instance\.this\.connection_name/g, `${remote}.database_connection_name`)
      .replace(/,?\s*google_service_networking_connection\.private_services/g, '');
    if (rel === 'variables.tf') {
      content = withoutVariables(content, dbVars) + `
variable "base_state_bucket" {
  description = "GCS bucket of the shared base stack's Terraform state (deploy.base)."
  type        = string
}

variable "base_state_prefix" {
  description = "Prefix of the base stack's state for this environment (for example base/dev)."
  type        = string
}
`;
    } else if (/^environments\/.+\.tfvars$/.test(rel)) {
      const env = path.basename(rel, '.tfvars');
      content = retfvars(content, /^(db_|create_private_service_access)/, [['base_state_bucket', hstr('<base-state-bucket>')], ['base_state_prefix', hstr(`base/${env}`)]]);
    }
    return { ...f, content };
  }).concat({
    filename: `${dir}/base.tf`,
    content: `# The shared base stack (deploy.base): the database of every service of the repository.
data "terraform_remote_state" "base" {
  backend = "gcs"

  config = {
    bucket = var.base_state_bucket
    prefix = var.base_state_prefix
  }
}
`
  });
}

/** One idempotent statement list per service: its database is only reachable with its own login. */
const isolationSql = (dialect: 'gcp' | 'azure') => `join("\\n", flatten([for service, id in local.services : [${dialect === 'azure' ? `
    format("DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s LOGIN PASSWORD '%s'; ELSE ALTER ROLE %s PASSWORD '%s'; END IF; END$$;", id, id, random_password.service[service].result, id, random_password.service[service].result),` : ''}
    format("REVOKE ALL ON DATABASE %s FROM PUBLIC;", id),
    format("GRANT ALL ON DATABASE %s TO %s;", id, id)
  ]]))`;

/** The base module (Google Cloud): Cloud SQL for PostgreSQL on a private IP, a user and a database per service. */
export function renderBaseGcp(services: BaseService[], deploy: DeployConfig, dir: string): TerraformFile[] {
  const ids = Object.fromEntries(services.map(s => [s.name, dbIdentifier(s.name)]));
  const versions = `terraform {
  required_version = ${hstr(TERRAFORM_REQUIRED)}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ${hstr(PROVIDERS.google)}
    }
    random = {
      source  = "hashicorp/random"
      version = ${hstr(PROVIDERS.random)}
    }
  }

  # One state per environment: terraform init -backend-config=environments/<env>.gcs.tfbackend
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
`;
  const variables = `variable "name" {
  description = "Prefix of the base resources."
  type        = string
  default     = "platform"
}

variable "environment" {
  description = "Environment name (${deploy.environments.join(', ')})."
  type        = string
}

variable "project_id" {
  description = "Google Cloud project."
  type        = string
}

variable "region" {
  description = "Region of the database."
  type        = string
  default     = ${hstr(deploy.region)}
}

variable "network" {
  description = "VPC network id (projects/<project>/global/networks/<name>) the services reach the database on."
  type        = string
}

variable "create_private_service_access" {
  description = "Create the private services access range and peering of the network (needed once per network for Cloud SQL private IP)."
  type        = bool
  default     = true
}

variable "db_tier" {
  description = "Cloud SQL machine tier shared by every service."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "17"
}

variable "db_require_tls" {
  description = "Reject unencrypted database connections (ENCRYPTED_ONLY)."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Labels added to every resource."
  type        = map(string)
  default     = {}
}
`;
  const main = `locals {
  name   = "\${var.name}-\${var.environment}"
  prod   = var.environment == "prod"
  labels = merge({ stack = "base", environment = var.environment, managed-by = "terraform" }, var.labels)

  # Service (kebab-case name) -> database and user name.
  services = ${Object.keys(ids).length ? `{\n${hattrs(Object.entries(ids).map(([k, v]) => [hstr(k), hstr(v)]), 4)}\n  }` : '{}'}
}

resource "google_project_service" "this" {
  for_each = toset(["sqladmin.googleapis.com", "servicenetworking.googleapis.com", "compute.googleapis.com"])

  service            = each.key
  disable_on_destroy = false
}
`;
  const database = `resource "google_compute_global_address" "private_services" {
  count = var.create_private_service_access ? 1 : 0

  name          = "\${local.name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = var.network
}

resource "google_service_networking_connection" "private_services" {
  count = var.create_private_service_access ? 1 : 0

  network                 = var.network
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services[0].name]
}

resource "google_sql_database_instance" "this" {
  name                = local.name
  database_version    = "POSTGRES_\${var.db_version}"
  region              = var.region
  deletion_protection = local.prod
  depends_on          = [google_project_service.this, google_service_networking_connection.private_services]

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = local.prod ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    user_labels       = local.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network
      ssl_mode        = var.db_require_tls ? "ENCRYPTED_ONLY" : "ALLOW_UNENCRYPTED_AND_ENCRYPTED"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = local.prod
    }
  }
}

# One user and one database per service.
resource "random_password" "service" {
  for_each = local.services

  length  = 32
  special = false
}

resource "google_sql_database" "service" {
  for_each = local.services

  name     = each.value
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "service" {
  for_each = local.services

  name     = each.value
  instance = google_sql_database_instance.this.name
  password = random_password.service[each.key].result
}
`;
  const outputs = `output "database_urls" {
  description = "DATABASE_URL of each service: its own user and database on the shared instance."
  sensitive   = true
  value = { for service, id in local.services :
    service => "postgres://\${id}:\${random_password.service[service].result}@\${google_sql_database_instance.this.private_ip_address}:5432/\${id}?sslmode=require"
  }
}

output "database_connection_name" {
  value = google_sql_database_instance.this.connection_name
}

# Cloud SQL users created by Terraform can connect to any database of the instance; run once after apply (and
# after adding a service) to keep each database to its own user:
#   terraform output -raw isolation_sql | psql "<postgres user connection>"
output "isolation_sql" {
  description = "Idempotent SQL that restricts each service's database to its own user."
  value = ${isolationSql('gcp')}
}
`;
  const tfvars = deploy.environments.flatMap(env => {
    const prod = env === 'prod';
    return [
      { filename: `${dir}/environments/${env}.tfvars`, content: `${hattrs([
        ['environment', hstr(env)],
        ['project_id', hstr('<project>')],
        ['region', hstr(deploy.region)],
        ['network', hstr('projects/<project>/global/networks/<network>')],
        ['db_tier', hstr(prod ? 'db-custom-2-7680' : 'db-custom-1-3840')]
      ], 0)}\n` },
      { filename: `${dir}/environments/${env}.gcs.tfbackend`, content: `${hattrs([['bucket', hstr('<base-state-bucket>')], ['prefix', hstr(`base/${env}`)]], 0)}\n` }
    ];
  });
  const readme = `# Shared base stack (Google Cloud)

Generated by gherkin-ai for the services whose \`gherkin-ai.config.json\` sets \`deploy.base.dir\` to this directory: ${services.map(s => `\`${s.name}\``).join(', ') || '(none yet)'}. It is rewritten by \`ghk generate\` in any of them.

1. Apply this stack first, once per environment:

   \`\`\`bash
   terraform init -backend-config=environments/dev.gcs.tfbackend
   terraform apply -var-file=environments/dev.tfvars
   \`\`\`

2. Keep each database to its own user (idempotent; rerun after adding a service), from a host on the VPC:

   \`\`\`bash
   terraform output -raw isolation_sql | psql "<connection as the postgres user>"
   \`\`\`

3. Apply each service module with \`base_state_bucket\` and \`base_state_prefix\` pointing at this stack's state.

Each service has its own user and database on the shared Cloud SQL instance, and keeps its own Pub/Sub topics and subscriptions.
`;
  return [
    { filename: `${dir}/versions.tf`, content: versions },
    { filename: `${dir}/variables.tf`, content: variables },
    { filename: `${dir}/main.tf`, content: main },
    { filename: `${dir}/database.tf`, content: database },
    { filename: `${dir}/outputs.tf`, content: outputs },
    ...tfvars,
    { filename: `${dir}/README.md`, content: readme }
  ];
}

// ---------------------------------------------------------------------------
// Azure (X-09b, 3.3.0): one PostgreSQL Flexible Server with a role and a database per service, and one Service Bus
// namespace when a service uses it (each service keeps its own topics and subscriptions in it).
// ---------------------------------------------------------------------------

/** The service module (Container Apps or a Linux VM), reading its database and Service Bus namespace from the base. */
export function applySharedBaseAzure(files: TerraformFile[], spec: ServiceSpec, deploy: DeployConfig): TerraformFile[] {
  const dir = 'deploy/terraform/azure';
  const remote = 'data.terraform_remote_state.base.outputs';
  const baseVars = /^(postgres_subnet_id|postgres_private_dns_zone_id|postgres_sku|postgres_version|postgres_storage_mb|db_require_tls|servicebus_sku)$/;
  return files.filter(f => f.filename !== `${dir}/database.tf`).map(f => {
    if (!f.filename.startsWith(`${dir}/`)) return f;
    const rel = f.filename.slice(dir.length + 1);
    let content = f.content
      .replace(/"postgres:\/\/\$\{azurerm_postgresql_flexible_server\.this\.administrator_login\}[^"]*"/g, `${remote}.database_urls[${hstr(spec.name)}]`)
      .replace(/azurerm_postgresql_flexible_server\.this\.fqdn/g, `${remote}.database_fqdn`);
    if (rel === 'servicebus.tf') content = content.replace(block('resource', 'azurerm_servicebus_namespace', 'this'), '');
    content = content
      .replace(/\$\{azurerm_servicebus_namespace\.this\.name\}/g, `\${${remote}.servicebus_namespace_name}`)
      .replace(/azurerm_servicebus_namespace\.this\.id/g, `${remote}.servicebus_namespace_id`);
    if (rel === 'variables.tf') {
      content = withoutVariables(content, baseVars) + `
variable "base_state_resource_group" {
  description = "Resource group of the storage account holding the shared base stack's Terraform state (deploy.base)."
  type        = string
}

variable "base_state_storage_account" {
  description = "Storage account of the base stack's state."
  type        = string
}

variable "base_state_container" {
  description = "Blob container of the base stack's state."
  type        = string
  default     = "tfstate"
}

variable "base_state_key" {
  description = "Key of the base stack's state for this environment (for example base/dev.tfstate)."
  type        = string
}
`;
    } else if (/^environments\/.+\.tfvars$/.test(rel)) {
      const env = path.basename(rel, '.tfvars');
      content = retfvars(content, /^(postgres_|db_require_tls|servicebus_sku)/, [
        ['base_state_resource_group', hstr('<state-resource-group>')], ['base_state_storage_account', hstr('<state-storage-account>')], ['base_state_key', hstr(`base/${env}.tfstate`)]
      ]);
    }
    return { ...f, content: content.replace(/\n{3,}/g, '\n\n') };
  }).concat({
    filename: `${dir}/base.tf`,
    content: `# The shared base stack (deploy.base): the database and Service Bus namespace of every service of the repository.
data "terraform_remote_state" "base" {
  backend = "azurerm"

  config = {
    resource_group_name  = var.base_state_resource_group
    storage_account_name = var.base_state_storage_account
    container_name       = var.base_state_container
    key                  = var.base_state_key
  }
}
`
  });
}

/** The base module (Azure): a Flexible Server in a delegated subnet, a role and a database per service, Service Bus. */
export function renderBaseAzure(services: BaseService[], deploy: DeployConfig, dir: string): TerraformFile[] {
  const sb = services.some(s => s.servicebus);
  const ids = Object.fromEntries(services.map(s => [s.name, dbIdentifier(s.name)]));
  const versions = `terraform {
  required_version = ${hstr(TERRAFORM_REQUIRED)}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ${hstr(PROVIDERS.azurerm)}
    }
    random = {
      source  = "hashicorp/random"
      version = ${hstr(PROVIDERS.random)}
    }
  }

  # One state per environment: terraform init -backend-config=environments/<env>.azurerm.tfbackend
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}
`;
  const variables = `variable "subscription_id" {
  description = "Azure subscription."
  type        = string
}

variable "name" {
  description = "Prefix of the base resources."
  type        = string
  default     = "platform"
}

variable "environment" {
  description = "Environment name (${deploy.environments.join(', ')})."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = ${hstr(deploy.region)}
}

variable "postgres_subnet_id" {
  description = "Subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers."
  type        = string
}

variable "postgres_private_dns_zone_id" {
  description = "Private DNS zone (<name>.postgres.database.azure.com) linked to the services' VNet."
  type        = string
}

variable "postgres_sku" {
  description = "Flexible Server SKU shared by every service."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "17"
}

variable "postgres_storage_mb" {
  description = "Storage of the server (MB)."
  type        = number
  default     = 32768
}

variable "db_require_tls" {
  description = "Reject unencrypted database connections (require_secure_transport)."
  type        = bool
  default     = true
}
${sb ? `
variable "servicebus_sku" {
  description = "Service Bus namespace SKU (Standard or Premium; topics need Standard or higher)."
  type        = string
  default     = "Standard"
}
` : ''}
variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}
`;
  const main = `locals {
  name    = "\${var.name}-\${var.environment}"
  compact = replace(local.name, "-", "")
  prod    = var.environment == "prod"
  tags    = merge({ stack = "base", environment = var.environment, managed-by = "terraform" }, var.tags)

  # Service (kebab-case name) -> database and role name.
  services = ${Object.keys(ids).length ? `{\n${hattrs(Object.entries(ids).map(([k, v]) => [hstr(k), hstr(v)]), 4)}\n  }` : '{}'}
}

resource "azurerm_resource_group" "this" {
  name     = "rg-\${local.name}"
  location = var.location
  tags     = local.tags
}
`;
  const database = `resource "random_password" "admin" {
  length  = 32
  special = false
}

resource "random_password" "service" {
  for_each = local.services

  length  = 32
  special = false
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "psql-\${local.name}"
  resource_group_name           = azurerm_resource_group.this.name
  location                      = azurerm_resource_group.this.location
  version                       = var.postgres_version
  sku_name                      = var.postgres_sku
  storage_mb                    = var.postgres_storage_mb
  delegated_subnet_id           = var.postgres_subnet_id
  private_dns_zone_id           = var.postgres_private_dns_zone_id
  public_network_access_enabled = false
  administrator_login           = "platform_admin"
  administrator_password        = random_password.admin.result
  backup_retention_days         = local.prod ? 35 : 7
  tags                          = local.tags

  dynamic "high_availability" {
    for_each = local.prod ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  lifecycle {
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
}

resource "azurerm_postgresql_flexible_server_configuration" "require_tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = var.db_require_tls ? "on" : "off"
}

resource "azurerm_postgresql_flexible_server_database" "service" {
  for_each = local.services

  name      = each.value
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}
`;
  const broker = `resource "azurerm_servicebus_namespace" "this" {
  name                = "sb-\${local.compact}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = var.servicebus_sku
  local_auth_enabled  = false
  tags                = local.tags
}
`;
  const outputs = `output "database_urls" {
  description = "DATABASE_URL of each service: its own role and database on the shared server."
  sensitive   = true
  value = { for service, id in local.services :
    service => "postgres://\${id}:\${random_password.service[service].result}@\${azurerm_postgresql_flexible_server.this.fqdn}:5432/\${id}?sslmode=require"
  }
}

output "database_fqdn" {
  value = azurerm_postgresql_flexible_server.this.fqdn
}

output "master_url" {
  description = "Administrator connection, for the bootstrap only."
  sensitive   = true
  value       = "postgres://platform_admin:\${random_password.admin.result}@\${azurerm_postgresql_flexible_server.this.fqdn}:5432/postgres?sslmode=require"
}

output "servicebus_namespace_id" {
  value = ${sb ? 'azurerm_servicebus_namespace.this.id' : 'null'}
}

output "servicebus_namespace_name" {
  value = ${sb ? 'azurerm_servicebus_namespace.this.name' : 'null'}
}

# Run once after apply, and again after adding a service, from a host on the VNet (psql):
#   terraform output -raw bootstrap_sql | psql "$(terraform output -raw master_url)"
output "bootstrap_sql" {
  description = "Idempotent SQL that creates each service's role and keeps its database to it (rerun to rotate passwords)."
  sensitive   = true
  value = ${isolationSql('azure')}
}
`;
  const tfvars = deploy.environments.flatMap(env => {
    const prod = env === 'prod';
    return [
      { filename: `${dir}/environments/${env}.tfvars`, content: `${hattrs([
        ['subscription_id', hstr('<subscription-id>')],
        ['environment', hstr(env)],
        ['location', hstr(deploy.region)],
        ['postgres_subnet_id', hstr('/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<postgres>')],
        ['postgres_private_dns_zone_id', hstr('/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Network/privateDnsZones/<name>.postgres.database.azure.com')],
        ['postgres_sku', hstr(prod ? 'GP_Standard_D2ds_v5' : 'B_Standard_B1ms')]
      ], 0)}\n` },
      { filename: `${dir}/environments/${env}.azurerm.tfbackend`, content: `${hattrs([['resource_group_name', hstr('<state-resource-group>')], ['storage_account_name', hstr('<state-storage-account>')], ['container_name', hstr('tfstate')], ['key', hstr(`base/${env}.tfstate`)]], 0)}\n` }
    ];
  });
  const readme = `# Shared base stack (Azure)

Generated by gherkin-ai for the services whose \`gherkin-ai.config.json\` sets \`deploy.base.dir\` to this directory: ${services.map(s => `\`${s.name}\``).join(', ') || '(none yet)'}. It is rewritten by \`ghk generate\` in any of them.

1. Apply this stack first, once per environment:

   \`\`\`bash
   terraform init -backend-config=environments/dev.azurerm.tfbackend
   terraform apply -var-file=environments/dev.tfvars
   \`\`\`

2. Create the roles of the services and keep each database to its own role (idempotent; rerun after adding a service), from a host on the VNet:

   \`\`\`bash
   terraform output -raw bootstrap_sql | psql "$(terraform output -raw master_url)"
   \`\`\`

3. Apply each service module with the \`base_state_*\` variables pointing at this stack's state.

Each service has its own role and database on the shared Flexible Server${sb ? ', and its own topics and subscriptions in the shared Service Bus namespace' : ''}.
`;
  return [
    { filename: `${dir}/versions.tf`, content: versions },
    { filename: `${dir}/variables.tf`, content: variables },
    { filename: `${dir}/main.tf`, content: main },
    { filename: `${dir}/database.tf`, content: database },
    ...(sb ? [{ filename: `${dir}/servicebus.tf`, content: broker }] : []),
    { filename: `${dir}/outputs.tf`, content: outputs },
    ...tfvars,
    { filename: `${dir}/README.md`, content: readme }
  ];
}
