/* ==========================================================================
   gherkin-ai-cli - Terraform for AWS: ECS Fargate + ALB, RDS PostgreSQL,
   Amazon MQ for RabbitMQ, Secrets Manager, CloudWatch Logs.

   The network (VPC and subnets) is an input: most organizations already own
   it. Verified by scripts/golden-build.js (terraform-aws): terraform init
   -backend=false, validate and fmt -check. Never applied in CI.
   ========================================================================== */

import { hattrs, hlist, hmap, hstr, dbIdentifier } from './hcl';
import type { DeployConfig, ServiceSecret, ServiceSpec } from './service-spec';
import { COLLECTOR_IMAGES, PROVIDERS, TERRAFORM_REQUIRED } from './terraform-versions';

export interface TerraformFile {
  filename: string;
  content: string;
}

const secretExpression = (s: ServiceSecret): string => {
  switch (s.source) {
    case 'database-url': return '"postgres://${aws_db_instance.this.username}:${random_password.db.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${aws_db_instance.this.db_name}"';
    case 'amqp-url': return '"amqps://app:${random_password.mq.result}@${trimprefix(aws_mq_broker.this.instances[0].endpoints[0], "amqps://")}"';
    case 'laravel-key': return '"base64:${random_bytes.app_key.base64}"';
    case 'input': return 'var.amqp_url';
    default: return `random_password.${s.name.toLowerCase()}.result`;
  }
};

export function renderTerraformAws(spec: ServiceSpec, deploy: DeployConfig): TerraformFile[] {
  const dir = 'deploy/terraform/aws';
  const randoms = spec.secrets.filter(s => s.source === 'random');
  const relay = spec.relayCommand;

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

  # Remote state, one per environment: terraform init -backend-config=environments/<env>.s3.tfbackend
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}
`;

  const variables = `variable "service_name" {
  description = "Service name: prefix of every resource."
  type        = string
  default     = ${hstr(spec.name)}
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

variable "image" {
  description = "Container image URI built from the generated Dockerfile (for example <account>.dkr.ecr.<region>.amazonaws.com/${spec.name}:<git-sha>)."
  type        = string
}

variable "vpc_id" {
  description = "VPC of the service."
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets of the load balancer (two or more availability zones)."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets of the tasks, the database and the broker (two or more availability zones, with egress to pull the image)."
  type        = list(string)
}

variable "allowed_cidrs" {
  description = "CIDR blocks allowed to reach the load balancer."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "certificate_arn" {
  description = "ACM certificate for HTTPS. Without it the load balancer only listens on HTTP (development)."
  type        = string
  default     = null
}

variable "cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64: must match the image."
  type        = string
  default     = "X86_64"
}

variable "desired_count" {
  description = "Minimum number of tasks."
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Maximum number of tasks (CPU target tracking)."
  type        = number
  default     = 6
}

variable "db_instance_class" {
  description = "RDS instance class."
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
  description = "Reject unencrypted database connections (rds.force_ssl). The connections stay inside the VPC either way."
  type        = bool
  default     = false
}

variable "mq_instance_type" {
  description = "Amazon MQ broker instance type (mq.t3.micro supports SINGLE_INSTANCE only)."
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

  validation {
    condition     = contains(["SINGLE_INSTANCE", "CLUSTER_MULTI_AZ"], var.mq_deployment_mode)
    error_message = "mq_deployment_mode must be SINGLE_INSTANCE or CLUSTER_MULTI_AZ."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}

variable "enable_tracing" {
  description = "Run the AWS Distro for OpenTelemetry collector as a sidecar: traces to X-Ray, metrics to CloudWatch."
  type        = bool
  default     = true
}

variable "otel_collector_image" {
  description = "ADOT collector image (sidecar)."
  type        = string
  default     = ${hstr(COLLECTOR_IMAGES.aws)}
}

variable "extra_environment" {
  description = "Additional plain environment variables of the container (for example OTEL_EXPORTER_OTLP_ENDPOINT)."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}
`;

  const main = `locals {
  name = "\${var.service_name}-\${var.environment}"
  prod = var.environment == "prod"

  tags = merge({
    service     = var.service_name
    environment = var.environment
    managed-by  = "terraform"
  }, var.tags)

  # Plain configuration of the container (the secrets are in secrets.tf). The service exports its traces over
  # OTLP to the collector sidecar (localhost in the task's network namespace).
  environment = merge(${hmap(Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, hstr(v)])), 2)}, var.enable_tracing ? { OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318" } : {}, var.extra_environment)

  otel_collector = {
    name      = "otel-collector"
    image     = var.otel_collector_image
    essential = false
    command   = ["--config=/etc/ecs/ecs-default-config.yaml"]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "otel"
      }
    }
  }
}
`;

  const network = `resource "aws_security_group" "alb" {
  name        = "\${local.name}-alb"
  description = "Load balancer of \${local.name}"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  name        = "\${local.name}-service"
  description = "Tasks of \${local.name}"
  vpc_id      = var.vpc_id

  ingress {
    description     = "From the load balancer"
    from_port       = ${spec.port}
    to_port         = ${spec.port}
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

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
    description     = "PostgreSQL from the tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
}

resource "aws_security_group" "broker" {
  name        = "\${local.name}-broker"
  description = "Amazon MQ of \${local.name}"
  vpc_id      = var.vpc_id

  ingress {
    description     = "AMQPS from the tasks"
    from_port       = 5671
    to_port         = 5671
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
}
`;

  const database = `resource "random_password" "db" {
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
    ['db_name', hstr(dbIdentifier(spec.name))],
    ['username', '"app"'],
    ['password', 'random_password.db.result'],
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

# Amazon MQ for RabbitMQ: the runtime's RabbitMQ adapter connects with AMQP_URL (amqps, port 5671).
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

  const secretNames = spec.secrets.map(s => s.name);
  const secrets = `${randoms.map(s => `resource "random_password" ${hstr(s.name.toLowerCase())} {
  length  = ${s.length ?? 48}
  special = false
}
`).join('\n')}${spec.secrets.some(s => s.source === 'laravel-key') ? `
resource "random_bytes" "app_key" {
  length = 32
}
` : ''}
locals {
  # Injected as environment variables from Secrets Manager (never in the task definition in clear text).
  secret_names = ${hlist(secretNames)}
  secret_values = ${hmap(Object.fromEntries(spec.secrets.map(s => [s.name, secretExpression(s)])), 2)}
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(local.secret_names)

  name                    = "\${local.name}/\${each.key}"
  recovery_window_in_days = local.prod ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each = toset(local.secret_names)

  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = local.secret_values[each.key]
}
`;

  const iam = `data "aws_iam_policy_document" "ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Pulls the image, writes logs and reads this service's secrets.
resource "aws_iam_role" "execution" {
  name               = "\${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [for secret in aws_secretsmanager_secret.this : secret.arn]
    }]
  })
}

# Identity of the application itself (add policies here for the AWS APIs the service calls).
resource "aws_iam_role" "task" {
  name               = "\${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks.json
}

# The ADOT collector sidecar writes traces to X-Ray and metrics to CloudWatch.
resource "aws_iam_role_policy_attachment" "telemetry" {
  for_each = var.enable_tracing ? toset([
    "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  ]) : toset([])

  role       = aws_iam_role.task.name
  policy_arn = each.value
}
`;

  // terraform fmt aligns consecutive one-line attributes: the relay has no portMappings block between them.
  const envs: [string, string][] = [
    ['environment', '[for key, value in local.environment : { name = key, value = value }]'],
    ['secrets', '[for key in local.secret_names : { name = key, valueFrom = aws_secretsmanager_secret.this[key].arn }]']
  ];
  const container = (name: string, command?: string[]) => `{
${command ? hattrs([['name', hstr(name)], ['image', 'var.image'], ['essential', 'true'], ['command', hlist(command)], ...envs], 4) : `${hattrs([['name', hstr(name)], ['image', 'var.image'], ['essential', 'true']], 4)}
    portMappings = [{
      containerPort = ${spec.port}
      protocol      = "tcp"
    }]
${hattrs(envs, 4)}`}
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = var.region
        awslogs-stream-prefix = ${hstr(name)}
      }
    }
  }`;

  const taskDefinition = (resource: string, family: string, name: string, command?: string[]) => `resource "aws_ecs_task_definition" ${hstr(resource)} {
  family                   = ${family}
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  depends_on               = [aws_secretsmanager_secret_version.this]

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode(concat([${container(name, command)}], var.enable_tracing ? [local.otel_collector] : []))
}
`;

  const service = `resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/\${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_lb" "this" {
  name                       = trimsuffix(substr(local.name, 0, 32), "-")
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "this" {
  name                 = trimsuffix(substr(local.name, 0, 32), "-")
  port                 = ${spec.port}
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  # Readiness probe of the generated application.
  health_check {
    path                = ${hstr(spec.health.ready)}
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.certificate_arn == null ? "forward" : "redirect"
    target_group_arn = var.certificate_arn == null ? aws_lb_target_group.this.arn : null

    dynamic "redirect" {
      for_each = var.certificate_arn == null ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

${taskDefinition('app', 'local.name', 'app')}
resource "aws_ecs_service" "app" {
  name                              = var.service_name
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 90
  depends_on                        = [aws_lb_listener.http]

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "app"
    container_port   = ${spec.port}
  }

  lifecycle {
    # The autoscaling policy owns the task count after the first deployment.
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "app" {
  min_capacity       = var.desired_count
  max_capacity       = var.max_count
  resource_id        = "service/\${aws_ecs_cluster.this.name}/\${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "\${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.app.resource_id
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension
  service_namespace  = aws_appautoscaling_target.app.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
${relay ? `
# The outbox relay of this stack is a separate process (${relay.join(' ')}): one task, no load balancer.
${taskDefinition('relay', '"${local.name}-relay"', 'relay', relay)}
resource "aws_ecs_service" "relay" {
  name            = "\${var.service_name}-relay"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.relay.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
}
` : ''}`;

  const outputs = `output "url" {
  description = "Public URL of the service."
  value       = "\${var.certificate_arn == null ? "http" : "https"}://\${aws_lb.this.dns_name}"
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "database_endpoint" {
  value = aws_db_instance.this.endpoint
}

output "broker_endpoint" {
  value = aws_mq_broker.this.instances[0].endpoints[0]
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}

output "secret_arns" {
  description = "Secrets Manager entries injected into the container."
  value       = { for key, secret in aws_secretsmanager_secret.this : key => secret.arn }
}
`;

  const envFiles = deploy.environments.flatMap(env => {
    const prod = env === 'prod';
    return [
      {
        filename: `${dir}/environments/${env}.tfvars`,
        content: `${hattrs([
          ['environment', hstr(env)],
          ['region', hstr(deploy.region)],
          ['image', hstr(`<account>.dkr.ecr.${deploy.region}.amazonaws.com/${spec.name}:<tag>`)],
          ['vpc_id', hstr('vpc-<id>')],
          ['public_subnet_ids', hlist(['subnet-<public-a>', 'subnet-<public-b>'])],
          ['private_subnet_ids', hlist(['subnet-<private-a>', 'subnet-<private-b>'])],
          ['desired_count', prod ? '2' : '1'],
          ['max_count', prod ? '6' : '2'],
          ['db_instance_class', hstr(prod ? 'db.m7g.large' : 'db.t4g.small')],
          ['db_multi_az', prod ? 'true' : 'false'],
          ['mq_instance_type', hstr(prod ? 'mq.m7g.medium' : 'mq.t3.micro')],
          ['mq_deployment_mode', hstr(prod ? 'CLUSTER_MULTI_AZ' : 'SINGLE_INSTANCE')]
        ], 0)}\n${prod ? '# certificate_arn = "arn:aws:acm:<region>:<account>:certificate/<id>"\n' : ''}`
      },
      {
        filename: `${dir}/environments/${env}.s3.tfbackend`,
        content: `bucket       = "<terraform-state-bucket>"\nkey          = "${spec.name}/${env}/terraform.tfstate"\nregion       = ${hstr(deploy.region)}\nuse_lockfile = true\n`
      }
    ];
  });

  return [
    { filename: `${dir}/versions.tf`, content: versions },
    { filename: `${dir}/variables.tf`, content: variables },
    { filename: `${dir}/main.tf`, content: main },
    { filename: `${dir}/network.tf`, content: network },
    { filename: `${dir}/database.tf`, content: database },
    { filename: `${dir}/broker.tf`, content: broker },
    { filename: `${dir}/secrets.tf`, content: secrets },
    { filename: `${dir}/iam.tf`, content: iam },
    { filename: `${dir}/service.tf`, content: service },
    { filename: `${dir}/outputs.tf`, content: outputs },
    ...envFiles
  ];
}
