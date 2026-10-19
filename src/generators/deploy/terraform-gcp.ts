/* ==========================================================================
   gherkin-ai-cli - Terraform for Google Cloud: Cloud Run (Direct VPC egress),
   Cloud SQL for PostgreSQL (private IP), Pub/Sub, Secret Manager.

   The VPC network is an input. The service account can only publish to and
   consume from this service's topics and subscriptions, so the runtime runs
   with GHK_DECLARE_TOPOLOGY=false. Verified by scripts/golden-build.js
   (terraform-gcp): init -backend=false, validate, fmt -check.
   ========================================================================== */

import { dbIdentifier, hattrs, hlist, hmap, hstr } from './hcl';
import type { DeployConfig, ServiceSecret, ServiceSpec } from './service-spec';
import type { TerraformFile } from './terraform-aws';
import { COLLECTOR_IMAGES, PROVIDERS, TERRAFORM_REQUIRED } from './terraform-versions';

const secretExpression = (s: ServiceSecret): string => {
  switch (s.source) {
    case 'database-url': return '"postgres://${google_sql_user.app.name}:${random_password.db.result}@${google_sql_database_instance.this.private_ip_address}:5432/${google_sql_database.app.name}"';
    case 'laravel-key': return '"base64:${random_bytes.app_key.base64}"';
    case 'input':
    case 'amqp-url': return 'var.amqp_url';
    default: return `random_password.${s.name.toLowerCase()}.result`;
  }
};

export function renderTerraformGcp(spec: ServiceSpec, deploy: DeployConfig): TerraformFile[] {
  const dir = 'deploy/terraform/gcp';
  const randoms = spec.secrets.filter(s => s.source === 'random');
  const relay = spec.relayCommand;
  const t = spec.topology;

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

  # Remote state, one per environment: terraform init -backend-config=environments/<env>.gcs.tfbackend
  backend "gcs" {}
}

provider "google" {
  project        = var.project_id
  region         = var.region
  default_labels = local.labels
}
`;

  const variables = `variable "project_id" {
  description = "Google Cloud project."
  type        = string
}

variable "service_name" {
  description = "Service name: prefix of every resource."
  type        = string
  default     = ${hstr(spec.name)}
}

variable "environment" {
  description = "Environment name (${deploy.environments.join(', ')})."
  type        = string
}

variable "region" {
  description = "Region of Cloud Run and Cloud SQL."
  type        = string
  default     = ${hstr(deploy.region)}
}

variable "image" {
  description = "Container image built from the generated Dockerfile (for example <region>-docker.pkg.dev/<project>/<repository>/${spec.name}:<git-sha>)."
  type        = string
}

variable "network" {
  description = "VPC network id (projects/<project>/global/networks/<name>): Cloud SQL private IP and Cloud Run egress."
  type        = string
}

variable "subnetwork" {
  description = "Subnetwork of the Cloud Run Direct VPC egress (same region)."
  type        = string
}

variable "create_private_service_access" {
  description = "Create the private services access range and peering of the network (needed once per network for Cloud SQL private IP)."
  type        = bool
  default     = false
}

variable "allow_unauthenticated" {
  description = "Let anyone invoke the service (the application still requires its JWT). Set false behind a load balancer or IAP."
  type        = bool
  default     = true
}

variable "cpu" {
  description = "CPU limit of each instance."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit of each instance."
  type        = string
  default     = "1Gi"
}

variable "min_instances" {
  description = "Minimum instances (above 0 avoids cold starts and keeps the in-process outbox relay running)."
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum instances."
  type        = number
  default     = 10
}

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "17"
}

variable "db_require_tls" {
  description = "Reject unencrypted database connections (ENCRYPTED_ONLY). The connections stay on the private network either way."
  type        = bool
  default     = false
}
${spec.secrets.some(s => s.source === 'input') ? `
variable "amqp_url" {
  description = "AMQP URL of the RabbitMQ broker."
  type        = string
  sensitive   = true
}
` : ''}
variable "enable_tracing" {
  description = "Run an OpenTelemetry collector sidecar that sends the traces to Cloud Trace."
  type        = bool
  default     = true
}

variable "otel_collector_image" {
  description = "OpenTelemetry collector (contrib) image of the sidecar."
  type        = string
  default     = ${hstr(COLLECTOR_IMAGES.contrib)}
}

variable "extra_environment" {
  description = "Additional plain environment variables of the container (for example OTEL_EXPORTER_OTLP_ENDPOINT)."
  type        = map(string)
  default     = {}
}

variable "labels" {
  description = "Labels added to every resource."
  type        = map(string)
  default     = {}
}
`;

  const main = `locals {
  name = "\${var.service_name}-\${var.environment}"
  prod = var.environment == "prod"

  labels = merge({
    service     = var.service_name
    environment = var.environment
    managed-by  = "terraform"
  }, var.labels)

  # Plain configuration of the container (the secrets are in secrets.tf). Traces go over OTLP to the collector
  # sidecar (containers of a Cloud Run instance share localhost).
  environment = merge(${hmap(Object.fromEntries(Object.entries({ ...spec.env, PUBSUB_PROJECT_ID: '${var.project_id}' }).map(([k, v]) => [k, `"${v}"`])), 2)}, var.enable_tracing ? { OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318" } : {}, var.extra_environment)

  # Collector sidecar configuration (passed with --config=env:OTELCOL_CONFIG): OTLP in, Cloud Trace out.
  otel_config = <<-YAML
    receivers:
      otlp:
        protocols:
          http:
            endpoint: localhost:4318
    processors:
      batch: {}
      resourcedetection:
        detectors: [env, gcp]
    exporters:
      googlecloud: {}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [resourcedetection, batch]
          exporters: [googlecloud]
  YAML
}

resource "google_project_iam_member" "trace_agent" {
  count = var.enable_tracing ? 1 : 0

  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = google_service_account.service.member
}

resource "google_project_service" "this" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "pubsub.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
  ])

  service            = each.key
  disable_on_destroy = false
}

# Identity of the service: least privilege on its own topics, subscriptions and secrets.
resource "google_service_account" "service" {
  account_id   = trimsuffix(substr(local.name, 0, 30), "-")
  display_name = "\${local.name} (Cloud Run)"
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

resource "random_password" "db" {
  length  = 32
  special = false
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

resource "google_sql_database" "app" {
  name     = ${hstr(dbIdentifier(spec.name))}
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.this.name
  password = random_password.db.result
}
`;

  const broker = `# Topology of the runtime (runtime/broker: exchange -> topic, queue -> subscription, DLX -> topic, DLQ -> subscription).
resource "google_pubsub_topic" "events" {
  name       = ${hstr(t.exchange)}
  depends_on = [google_project_service.this]
}

resource "google_pubsub_topic" "dlx" {
  name       = ${hstr(t.dlx)}
  depends_on = [google_project_service.this]
}

resource "google_pubsub_subscription" "consumer" {
  name                       = ${hstr(t.queue)}
  topic                      = google_pubsub_topic.events.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
}

resource "google_pubsub_subscription" "dlq" {
  name                       = ${hstr(t.dlq)}
  topic                      = google_pubsub_topic.dlx.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
}

# Publishes events (outbox relay) and dead-letters failed messages (inbox consumer).
resource "google_pubsub_topic_iam_member" "publisher" {
  for_each = {
    events = google_pubsub_topic.events.name
    dlx    = google_pubsub_topic.dlx.name
  }

  topic  = each.value
  role   = "roles/pubsub.publisher"
  member = google_service_account.service.member
}

resource "google_pubsub_subscription_iam_member" "subscriber" {
  for_each = {
    consumer = google_pubsub_subscription.consumer.name
    dlq      = google_pubsub_subscription.dlq.name
  }

  subscription = each.value
  role         = "roles/pubsub.subscriber"
  member       = google_service_account.service.member
}
`;

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
  # Injected as environment variables from Secret Manager.
  secret_names = ${hlist(spec.secrets.map(s => s.name))}
  secret_values = ${hmap(Object.fromEntries(spec.secrets.map(s => [s.name, secretExpression(s)])), 2)}
}

resource "google_secret_manager_secret" "this" {
  for_each = toset(local.secret_names)

  secret_id  = "\${local.name}-\${lower(replace(each.key, "_", "-"))}"
  depends_on = [google_project_service.this]

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "this" {
  for_each = toset(local.secret_names)

  secret      = google_secret_manager_secret.this[each.key].id
  secret_data = local.secret_values[each.key]
}

resource "google_secret_manager_secret_iam_member" "service" {
  for_each = toset(local.secret_names)

  secret_id = google_secret_manager_secret.this[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.service.member
}
`;

  const containerEnv = `
      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(local.secret_names)
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.this[env.key].secret_id
              version = "latest"
            }
          }
        }
      }`;

  const collectorSidecar = `

    dynamic "containers" {
      for_each = var.enable_tracing ? [1] : []
      content {
        name  = "otel-collector"
        image = var.otel_collector_image
        args  = ["--config=env:OTELCOL_CONFIG"]

        env {
          name  = "OTELCOL_CONFIG"
          value = local.otel_config
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }`;

  const vpcAccess = `
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
    }`;

  const service = `resource "google_cloud_run_v2_service" "app" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = local.prod
  depends_on          = [google_secret_manager_secret_version.this, google_secret_manager_secret_iam_member.service]

  template {
    service_account = google_service_account.service.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
${vpcAccess}

    containers {
      name  = "app"
      image = var.image

      ports {
        container_port = ${spec.port}
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # CPU stays allocated between requests: the in-process outbox relay keeps publishing.
        cpu_idle = false
      }
${containerEnv}

      startup_probe {
        failure_threshold = 30
        period_seconds    = 5

        http_get {
          path = ${hstr(spec.health.ready)}
        }
      }

      liveness_probe {
        http_get {
          path = ${hstr(spec.health.live)}
        }
      }
    }${collectorSidecar}
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count = var.allow_unauthenticated ? 1 : 0

  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
${relay ? `
# The outbox relay of this stack is a separate process (${relay.join(' ')}) that serves no HTTP: a worker pool.
resource "google_cloud_run_v2_worker_pool" "relay" {
  name                = "\${var.service_name}-relay"
  location            = var.region
  deletion_protection = local.prod
  depends_on          = [google_secret_manager_secret_version.this, google_secret_manager_secret_iam_member.service]

  scaling {
    manual_instance_count = 1
  }

  template {
    service_account = google_service_account.service.email
${vpcAccess}

    containers {
      name    = "relay"
      image   = var.image
      command = ${hlist(relay)}
${containerEnv}
    }${collectorSidecar}
  }
}
` : ''}`;

  const outputs = `output "url" {
  description = "URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.app.uri
}

output "service_account" {
  value = google_service_account.service.email
}

output "database_connection_name" {
  value = google_sql_database_instance.this.connection_name
}

output "topics" {
  value = [google_pubsub_topic.events.name, google_pubsub_topic.dlx.name]
}
`;

  const envFiles = deploy.environments.flatMap(env => {
    const prod = env === 'prod';
    return [
      {
        filename: `${dir}/environments/${env}.tfvars`,
        content: `${hattrs([
          ['project_id', hstr(`<project>-${env}`)],
          ['environment', hstr(env)],
          ['region', hstr(deploy.region)],
          ['image', hstr(`${deploy.region}-docker.pkg.dev/<project>/<repository>/${spec.name}:<tag>`)],
          ['network', hstr('projects/<project>/global/networks/<network>')],
          ['subnetwork', hstr(`projects/<project>/regions/${deploy.region}/subnetworks/<subnetwork>`)],
          ['min_instances', prod ? '2' : '1'],
          ['max_instances', prod ? '20' : '3'],
          ['db_tier', hstr(prod ? 'db-custom-2-7680' : 'db-custom-1-3840')]
        ], 0)}\n`
      },
      {
        filename: `${dir}/environments/${env}.gcs.tfbackend`,
        content: `bucket = "<terraform-state-bucket>"\nprefix = "${spec.name}/${env}"\n`
      }
    ];
  });

  return [
    { filename: `${dir}/versions.tf`, content: versions },
    { filename: `${dir}/variables.tf`, content: variables },
    { filename: `${dir}/main.tf`, content: main },
    { filename: `${dir}/database.tf`, content: database },
    { filename: `${dir}/pubsub.tf`, content: broker },
    { filename: `${dir}/secrets.tf`, content: secrets },
    { filename: `${dir}/service.tf`, content: service },
    { filename: `${dir}/outputs.tf`, content: outputs },
    ...envFiles
  ];
}
