/* ==========================================================================
   gherkin-ai-cli - Broker configuration of the generated service

   The runtime kernel picks its broker at start-up (GHK_BROKER, then the
   variables that are set, then stack.messaging). These helpers give the
   variables of that default broker to docker-compose, .env.example and the
   Dockerfile header, so local runs and deployments use the same broker as
   the generated code (docs/DEPLOYMENT.md).
   ========================================================================== */

import type { GherkinAIConfig } from '../../core/config';
import { defaultJvmBroker } from '../kernel/runtime/jvm';

export type RuntimeBroker = 'rabbitmq' | 'pubsub' | 'servicebus' | 'kafka';

/** Languages whose runtime has no Service Bus adapter (no official SDK): they keep RabbitMQ on Azure. */
const NO_SERVICEBUS = ['rust', 'ruby', 'elixir', 'php'];

/** Languages whose runtime has a Kafka adapter; the others keep RabbitMQ with stack.messaging "kafka". */
export const KAFKA_LANGUAGES = ['java', 'kotlin', 'typescript', 'javascript', 'csharp', 'dotnet', '.net', 'python', 'go'];

/** Single-node Kafka (KRaft) for docker-compose and the golden builds. */
export const KAFKA_IMAGE = 'apache/kafka:4.1.0';

/** The broker the generated runtime uses by default for this configuration. */
export function runtimeBroker(config: Pick<GherkinAIConfig, 'stack'>): RuntimeBroker {
  const broker = defaultJvmBroker(config.stack?.messaging);
  const language = (config.stack?.language || '').toLowerCase();
  if (broker === 'servicebus' && NO_SERVICEBUS.includes(language)) return 'rabbitmq';
  if (broker === 'kafka' && !KAFKA_LANGUAGES.includes(language)) return 'rabbitmq';
  return broker;
}

/** Names of the variables that configure the broker in production (Dockerfile header, deployment docs). */
export function brokerVariables(config: Pick<GherkinAIConfig, 'stack'>): string[] {
  switch (runtimeBroker(config)) {
    case 'pubsub': return ['GHK_BROKER', 'PUBSUB_PROJECT_ID'];
    case 'servicebus': return ['GHK_BROKER', 'SERVICEBUS_NAMESPACE'];
    case 'kafka': return ['GHK_BROKER', 'KAFKA_BOOTSTRAP_SERVERS'];
    default: return ['AMQP_URL'];
  }
}

/** .env.example lines for the broker, for a service running on the host (emulators on localhost). */
export function brokerEnvExample(config: Pick<GherkinAIConfig, 'stack'>, amqpUrl: string): string {
  switch (runtimeBroker(config)) {
    case 'pubsub':
      return [
        'GHK_BROKER=pubsub',
        'PUBSUB_PROJECT_ID=<gcp-project-id>',
        '# Local Pub/Sub emulator (docker compose up pubsub); unset in GCP, where the workload identity is used',
        'PUBSUB_EMULATOR_HOST=localhost:8085'
      ].join('\n');
    case 'servicebus':
      return [
        'GHK_BROKER=servicebus',
        '# Microsoft Entra ID (managed identity) in Azure',
        'SERVICEBUS_NAMESPACE=<namespace>.servicebus.windows.net',
        '# Or a shared-access-key connection string (also used for the Service Bus emulator)',
        '# SERVICEBUS_CONNECTION_STRING=Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
      ].join('\n');
    case 'kafka':
      return [
        'GHK_BROKER=kafka',
        '# Local Kafka (docker compose up kafka); in production the bootstrap servers of MSK, Confluent Cloud or Event Hubs',
        'KAFKA_BOOTSTRAP_SERVERS=localhost:9092',
        '# Managed clusters: SASL_SSL with PLAIN or SCRAM-SHA-512',
        '# KAFKA_SECURITY_PROTOCOL=SASL_SSL',
        '# KAFKA_SASL_MECHANISM=PLAIN',
        '# KAFKA_SASL_USERNAME=<key>',
        '# KAFKA_SASL_PASSWORD=<secret>'
      ].join('\n');
    default:
      return `AMQP_URL=${amqpUrl}`;
  }
}
