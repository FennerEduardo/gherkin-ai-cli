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

   AWS only in this version; the other clouds report a configuration error.
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

const block = (kind: string, a: string, b?: string) => new RegExp(`${kind} "${a}"${b ? ` "${b}"` : ''} \\{[\\s\\S]*?\\n\\}\\n\\n?`, 'g');

/** Re-renders `key = value` lines (a tfvars file) without some keys and with others added, aligned as terraform fmt does. */
function retfvars(content: string, drop: RegExp, add: [string, string][]): string {
  const comments = content.split('\n').filter(l => l.startsWith('#'));
  const entries = content.split('\n').map(l => l.match(/^([a-z_]+)\s+= (.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m))
    .filter(m => !drop.test(m[1])).map(m => [m[1], m[2]] as [string, string]);
  return `${hattrs([...entries, ...add], 0)}\n${comments.length ? `${comments.join('\n')}\n` : ''}`;
}

export interface BaseService {
  name: string;
  rabbitmq: boolean;
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
    if (!c.deploy?.base?.dir || path.resolve(project, c.deploy.base.dir) !== baseDir || c.deploy.cloud !== 'aws') continue;
    const name = toKebab(c.projectName || path.basename(project));
    services.set(name, { name, rabbitmq: cloudBroker(c, 'aws') === 'rabbitmq' });
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
  if (deploy.cloud !== 'aws') {
    throw new ConfigError(`deploy.base is generated for AWS only in this version (deploy.cloud is "${deploy.cloud}").`, { hint: 'Remove deploy.base to give the service its own database and broker.' });
  }
  const cwd = process.cwd();
  const outDir = path.resolve(cwd, config.outputDir || '.');
  const baseDir = path.relative(outDir, path.resolve(cwd, config.deploy!.base!.dir, 'aws')).split(path.sep).join('/');
  return [...applySharedBaseAws(serviceFiles, spec, deploy), ...renderBaseAws(baseServices(config, cwd), deploy, baseDir)];
}
