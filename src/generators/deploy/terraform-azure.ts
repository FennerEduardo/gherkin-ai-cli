/* ==========================================================================
   gherkin-ai-cli - Terraform for Azure: Container Apps, PostgreSQL Flexible
   Server (VNet-integrated), Key Vault (RBAC), Service Bus (Entra ID) or an
   external RabbitMQ (AMQP_URL), Log Analytics.

   The virtual network subnets and the PostgreSQL private DNS zone are
   inputs. Verified by scripts/golden-build.js (terraform-azure): init
   -backend=false, validate, fmt -check.
   ========================================================================== */

import { dbIdentifier, hattrs, hlist, hmap, hstr } from './hcl';
import { inputTfvarsNote, inputVariables, type DeployConfig, type ServiceSecret, type ServiceSpec } from './service-spec';
import type { TerraformFile } from './terraform-aws';
import { COLLECTOR_IMAGES, PROVIDERS, TERRAFORM_REQUIRED } from './terraform-versions';

const secretExpression = (s: ServiceSecret): string => {
  switch (s.source) {
    case 'database-url': return '"postgres://${azurerm_postgresql_flexible_server.this.administrator_login}:${random_password.db.result}@${azurerm_postgresql_flexible_server.this.fqdn}:5432/${azurerm_postgresql_flexible_server_database.app.name}?sslmode=require"';
    case 'laravel-key': return '"base64:${random_bytes.app_key.base64}"';
    case 'input': return `var.${s.variable}`;
    default: return `random_password.${s.name.toLowerCase()}.result`;
  }
};

/** Key Vault secret names allow letters, digits and dashes only. */
const kvName = (name: string) => name.toLowerCase().replace(/_/g, '-');

export function renderTerraformAzure(spec: ServiceSpec, deploy: DeployConfig): TerraformFile[] {
  const dir = 'deploy/terraform/azure';
  const randoms = spec.secrets.filter(s => s.source === 'random');
  const relay = spec.relayCommand;
  const serviceBus = spec.broker === 'servicebus';
  const t = spec.topology;

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

  # Remote state, one per environment: terraform init -backend-config=environments/<env>.azurerm.tfbackend
  backend "azurerm" {}
}

provider "azurerm" {
  subscription_id = var.subscription_id

  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
}
`;

  const variables = `variable "subscription_id" {
  description = "Azure subscription."
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

variable "location" {
  description = "Azure region."
  type        = string
  default     = ${hstr(deploy.region)}
}

variable "image" {
  description = "Container image built from the generated Dockerfile (for example <registry>.azurecr.io/${spec.name}:<git-sha>)."
  type        = string
}

variable "registry_server" {
  description = "Azure Container Registry login server pulled with the app identity (AcrPull). Null for a public image."
  type        = string
  default     = null
}

variable "container_apps_subnet_id" {
  description = "Subnet of the Container Apps environment (/27 or larger, delegated to Microsoft.App/environments)."
  type        = string
}

variable "postgres_subnet_id" {
  description = "Subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers."
  type        = string
}

variable "postgres_private_dns_zone_id" {
  description = "Private DNS zone <name>.postgres.database.azure.com linked to the virtual network."
  type        = string
}

variable "cpu" {
  description = "vCPU of each replica."
  type        = number
  default     = 0.5
}

variable "memory" {
  description = "Memory of each replica (must match the CPU: 0.5 -> 1Gi, 1 -> 2Gi)."
  type        = string
  default     = "1Gi"
}

variable "min_replicas" {
  description = "Minimum replicas (above 0 keeps the in-process outbox relay running)."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum replicas."
  type        = number
  default     = 10
}

variable "postgres_sku" {
  description = "PostgreSQL Flexible Server SKU."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "17"
}

variable "postgres_storage_mb" {
  description = "PostgreSQL storage (MB)."
  type        = number
  default     = 32768
}

variable "db_require_tls" {
  description = "Reject unencrypted database connections (require_secure_transport). The connections stay in the virtual network either way."
  type        = bool
  default     = true
}
${serviceBus ? `
variable "servicebus_sku" {
  description = "Service Bus namespace SKU (topics need Standard or Premium)."
  type        = string
  default     = "Standard"
}
` : ''}${inputVariables(spec)}
variable "enable_tracing" {
  description = "Run an OpenTelemetry collector sidecar that sends the traces to Application Insights (Azure Monitor)."
  type        = bool
  default     = true
}

variable "otel_collector_image" {
  description = "OpenTelemetry collector (contrib) image of the sidecar."
  type        = string
  default     = ${hstr(COLLECTOR_IMAGES.contrib)}
}

variable "log_retention_days" {
  description = "Log Analytics retention."
  type        = number
  default     = 30
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

  const plainEnv: Record<string, string> = Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, hstr(v)]));
  plainEnv.AZURE_CLIENT_ID = 'azurerm_user_assigned_identity.app.client_id';
  if (serviceBus) plainEnv.SERVICEBUS_NAMESPACE = '"${azurerm_servicebus_namespace.this.name}.servicebus.windows.net"';

  const main = `data "azurerm_client_config" "current" {}

locals {
  name = "\${var.service_name}-\${var.environment}"
  prod = var.environment == "prod"
  # Globally unique, alphanumeric names (Key Vault: 3-24 characters).
  compact = substr(replace(local.name, "-", ""), 0, 17)

  tags = merge({
    service     = var.service_name
    environment = var.environment
    managed-by  = "terraform"
  }, var.tags)

  # Plain configuration of the container (the secrets are in secrets.tf). AZURE_CLIENT_ID selects the
  # user-assigned identity for DefaultAzureCredential. Traces go over OTLP to the collector sidecar.
  environment = merge(${hmap(plainEnv, 2)}, var.enable_tracing ? { OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318" } : {}, var.extra_environment)

  # Collector sidecar configuration (passed with --config=env:OTELCOL_CONFIG): OTLP in, Azure Monitor out.
  otel_config = <<-YAML
    receivers:
      otlp:
        protocols:
          http:
            endpoint: localhost:4318
    processors:
      batch: {}
    exporters:
      azuremonitor:
        connection_string: $\${env:APPLICATIONINSIGHTS_CONNECTION_STRING}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [azuremonitor]
  YAML
}

resource "azurerm_application_insights" "this" {
  count = var.enable_tracing ? 1 : 0

  name                = "appi-\${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  workspace_id        = azurerm_log_analytics_workspace.this.id
  application_type    = "other"
  tags                = local.tags
}

resource "azurerm_resource_group" "this" {
  name     = "rg-\${local.name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-\${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

# Identity of the service: Key Vault secrets${serviceBus ? ', Service Bus data roles' : ''} and the registry.
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-\${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  count = var.registry_server == null ? 0 : 1

  scope                = "/subscriptions/\${var.subscription_id}"
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
`;

  const database = `resource "random_password" "db" {
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
  administrator_login           = "app"
  administrator_password        = random_password.db.result
  backup_retention_days         = local.prod ? 35 : 7
  tags                          = local.tags

  dynamic "high_availability" {
    for_each = local.prod ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  lifecycle {
    # Azure picks the zone; failovers change it.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
}

resource "azurerm_postgresql_flexible_server_configuration" "require_tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = var.db_require_tls ? "on" : "off"
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = ${hstr(dbIdentifier(spec.name))}
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}
`;

  const broker = serviceBus ? `# Topology of the runtime (runtime/broker: exchange -> topic, queue -> subscription, DLX -> topic, DLQ -> subscription).
resource "azurerm_servicebus_namespace" "this" {
  name                = "sb-\${local.compact}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = var.servicebus_sku
  local_auth_enabled  = false
  tags                = local.tags
}

resource "azurerm_servicebus_topic" "events" {
  name         = ${hstr(t.exchange)}
  namespace_id = azurerm_servicebus_namespace.this.id
}

resource "azurerm_servicebus_topic" "dlx" {
  name         = ${hstr(t.dlx)}
  namespace_id = azurerm_servicebus_namespace.this.id
}

resource "azurerm_servicebus_subscription" "consumer" {
  name               = ${hstr(t.queue)}
  topic_id           = azurerm_servicebus_topic.events.id
  max_delivery_count = 10
}

resource "azurerm_servicebus_subscription" "dlq" {
  name               = ${hstr(t.dlq)}
  topic_id           = azurerm_servicebus_topic.dlx.id
  max_delivery_count = 10
}

# Entra ID only (no shared access keys): publish and consume, no management rights.
resource "azurerm_role_assignment" "servicebus" {
  for_each = toset(["Azure Service Bus Data Sender", "Azure Service Bus Data Receiver"])

  scope                = azurerm_servicebus_namespace.this.id
  role_definition_name = each.key
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
` : '';

  const secrets = `${randoms.map(s => `resource "random_password" ${hstr(s.name.toLowerCase())} {
  length  = ${s.length ?? 48}
  special = false
}
`).join('\n')}${spec.secrets.some(s => s.source === 'laravel-key') ? `
resource "random_bytes" "app_key" {
  length = 32
}
` : ''}
resource "azurerm_key_vault" "this" {
  name                       = "kv-\${local.compact}"
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = local.prod
  soft_delete_retention_days = local.prod ? 90 : 7
  tags                       = local.tags
}

# The identity running Terraform writes the secrets; the service identity only reads them.
resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_role_assignment" "app_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

locals {
  # Injected as environment variables from Key Vault (secret name -> Key Vault name).
  secret_names = ${hlist(spec.secrets.map(s => s.name))}
  secret_vault_names = ${hmap(Object.fromEntries(spec.secrets.map(s => [s.name, hstr(kvName(s.name))])), 2)}
  secret_values = ${hmap(Object.fromEntries(spec.secrets.map(s => [s.name, secretExpression(s)])), 2)}
}

resource "azurerm_key_vault_secret" "this" {
  for_each = toset(local.secret_names)

  name         = local.secret_vault_names[each.key]
  value        = local.secret_values[each.key]
  key_vault_id = azurerm_key_vault.this.id
  depends_on   = [azurerm_role_assignment.deployer_secrets]
}
`;

  const containerBody = (command?: string[]) => `
    container {
      name   = ${hstr(command ? 'relay' : 'app')}
      image  = var.image
      cpu    = var.cpu
      memory = var.memory${command ? `
      command = ${hlist(command)}` : ''}

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
          name        = env.key
          secret_name = local.secret_vault_names[env.key]
        }
      }${command ? '' : `

      liveness_probe {
        transport = "HTTP"
        port      = ${spec.port}
        path      = ${hstr(spec.health.live)}
      }

      readiness_probe {
        transport = "HTTP"
        port      = ${spec.port}
        path      = ${hstr(spec.health.ready)}
      }`}
    }`;

  const app = (resource: string, name: string, command?: string[]) => `resource "azurerm_container_app" ${hstr(resource)} {
  name                         = ${name}
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = local.tags
  depends_on                   = [azurerm_role_assignment.app_secrets, azurerm_key_vault_secret.this]

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  dynamic "registry" {
    for_each = var.registry_server == null ? [] : [var.registry_server]
    content {
      server   = registry.value
      identity = azurerm_user_assigned_identity.app.id
    }
  }

  dynamic "secret" {
    for_each = toset(local.secret_names)
    content {
      name                = local.secret_vault_names[secret.key]
      key_vault_secret_id = azurerm_key_vault_secret.this[secret.key].versionless_id
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  dynamic "secret" {
    for_each = var.enable_tracing ? [1] : []
    content {
      name  = "appinsights-connection-string"
      value = azurerm_application_insights.this[0].connection_string
    }
  }
${command ? '' : `
  ingress {
    external_enabled = true
    target_port      = ${spec.port}
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
`}
  template {
    min_replicas = ${command ? '1' : 'var.min_replicas'}
    max_replicas = ${command ? '1' : 'var.max_replicas'}
${containerBody(command)}

    dynamic "container" {
      for_each = var.enable_tracing ? [1] : []
      content {
        name   = "otel-collector"
        image  = var.otel_collector_image
        cpu    = 0.25
        memory = "0.5Gi"
        args   = ["--config=env:OTELCOL_CONFIG"]

        env {
          name  = "OTELCOL_CONFIG"
          value = local.otel_config
        }

        env {
          name        = "APPLICATIONINSIGHTS_CONNECTION_STRING"
          secret_name = "appinsights-connection-string"
        }
      }
    }
  }
}
`;

  const service = `resource "azurerm_container_app_environment" "this" {
  name                       = "cae-\${local.name}"
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  infrastructure_subnet_id   = var.container_apps_subnet_id
  tags                       = local.tags
}

${app('app', 'trimsuffix(substr("ca-${local.name}", 0, 32), "-")')}${relay ? `
# The outbox relay of this stack is a separate process (${relay.join(' ')}): one replica, no ingress.
${app('relay', 'trimsuffix(substr("ca-${local.name}-relay", 0, 32), "-")', relay)}` : ''}`;

  const outputs = `output "url" {
  description = "URL of the Container App."
  value       = "https://\${azurerm_container_app.app.ingress[0].fqdn}"
}

output "resource_group" {
  value = azurerm_resource_group.this.name
}

output "identity_client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}

output "database_fqdn" {
  value = azurerm_postgresql_flexible_server.this.fqdn
}

output "key_vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}
${serviceBus ? `
output "servicebus_namespace" {
  value = "\${azurerm_servicebus_namespace.this.name}.servicebus.windows.net"
}
` : ''}`;

  const envFiles = deploy.environments.flatMap(env => {
    const prod = env === 'prod';
    return [
      {
        filename: `${dir}/environments/${env}.tfvars`,
        content: `${hattrs([
          ['subscription_id', hstr('<subscription-id>')],
          ['environment', hstr(env)],
          ['location', hstr(deploy.region)],
          ['image', hstr(`<registry>.azurecr.io/${spec.name}:<tag>`)],
          ['registry_server', hstr('<registry>.azurecr.io')],
          ['container_apps_subnet_id', hstr('/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<apps>')],
          ['postgres_subnet_id', hstr('/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<postgres>')],
          ['postgres_private_dns_zone_id', hstr('/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Network/privateDnsZones/<name>.postgres.database.azure.com')],
          ['min_replicas', prod ? '2' : '1'],
          ['max_replicas', prod ? '20' : '3'],
          ['postgres_sku', hstr(prod ? 'GP_Standard_D2ds_v5' : 'B_Standard_B1ms')]
        ], 0)}\n${inputTfvarsNote(spec)}`
      },
      {
        filename: `${dir}/environments/${env}.azurerm.tfbackend`,
        content: `resource_group_name  = "<state-resource-group>"\nstorage_account_name = "<statestorageaccount>"\ncontainer_name       = "tfstate"\nkey                  = "${spec.name}/${env}.tfstate"\nuse_azuread_auth     = true\n`
      }
    ];
  });

  return [
    { filename: `${dir}/versions.tf`, content: versions },
    { filename: `${dir}/variables.tf`, content: variables },
    { filename: `${dir}/main.tf`, content: main },
    { filename: `${dir}/database.tf`, content: database },
    ...(serviceBus ? [{ filename: `${dir}/servicebus.tf`, content: broker }] : []),
    { filename: `${dir}/secrets.tf`, content: secrets },
    { filename: `${dir}/service.tf`, content: service },
    { filename: `${dir}/outputs.tf`, content: outputs },
    ...envFiles
  ];
}
