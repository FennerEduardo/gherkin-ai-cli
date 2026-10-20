import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';
import { buildIR } from '../../src/core/ir-builder';
import { renderDeploymentTargets } from '../../src/generators/deploy/targets';
import { brokerEnvExample, brokerVariables, runtimeBroker } from '../../src/generators/deploy/broker-env';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const cfg = (language: string, framework: string, messaging = 'kafka') =>
  ({ ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language, framework, messaging } });
const ir = buildIR(parsed, 'orders.feature');
const files = (language: string, framework: string, messaging = 'kafka'): { filename: string; content: string }[] => {
  const c = cfg(language, framework, messaging);
  const buildFiles = [generateContracts(parsed, ir, c).projectRootFile].flat().filter(Boolean) as { filename: string; content: string }[];
  return [...generatePresets(parsed, c), ...buildFiles];
};
const find = (fs: { filename: string; content: string }[], re: RegExp) => fs.find(f => re.test(f.filename));

// 4.1 (3.2 scope): Kafka as one more broker adapter behind the runtime kernel's ports.
const STACKS: [string, string, RegExp, RegExp, string][] = [
  ['java', 'spring', /runtime\/KafkaBroker\.java$/, /^pom\.xml$/, 'kafka-clients'],
  ['java', 'quarkus', /runtime\/KafkaBroker\.java$/, /^pom\.xml$/, 'kafka-clients'],
  ['kotlin', 'spring', /runtime\/KafkaBroker\.java$/, /^build\.gradle\.kts$/, 'org.apache.kafka:kafka-clients'],
  ['typescript', 'nestjs', /runtime\/kafka-broker\.ts$/, /package\.json$/, '@confluentinc/kafka-javascript'],
  ['csharp', 'dotnet', /Runtime\/KafkaBroker\.cs$/, /\.csproj$/, 'Confluent.Kafka'],
  ['python', 'fastapi', /runtime\/kafka_broker\.py$/, /pyproject\.toml$/, 'confluent-kafka'],
  ['go', 'chi', /runtime\/kafka_broker\.go$/, /^go\.mod$/, 'github.com/twmb/franz-go']
];

describe('Kafka broker adapters (4.1)', () => {
  it.each(STACKS)('%s/%s: adapter, dependency and run-time selection with stack.messaging "kafka"', (language, framework, adapter, build, dependency) => {
    const generated = files(language, framework);
    expect(find(generated, adapter), 'adapter').toBeDefined();
    expect(generated.filter(f => build.test(f.filename)).map(f => f.content).join('\n'), 'dependency').toContain(dependency);
    expect(generated.map(f => f.content).join('\n')).toContain('KAFKA_BOOTSTRAP_SERVERS');
    expect(runtimeBroker(cfg(language, framework))).toBe('kafka');
  });

  it.each(STACKS)('%s/%s: nothing Kafka-specific without it', (language, framework, adapter, build, dependency) => {
    const generated = files(language, framework, 'rabbitmq');
    expect(find(generated, adapter)).toBeUndefined();
    expect(generated.filter(f => build.test(f.filename)).map(f => f.content).join('\n')).not.toContain(dependency);
  });

  it('deploys against an existing Kafka cluster on every cloud, without the native broker', () => {
    for (const [cloud, native] of [['aws', 'aws_mq_broker'], ['gcp', 'google_pubsub_topic'], ['azure', 'azurerm_servicebus_namespace']] as const) {
      const tf = renderDeploymentTargets({ ...cfg('go', 'chi'), deploy: { cloud } }).map(f => f.content).join('\n');
      expect(tf, cloud).not.toContain(native);
      for (const v of ['kafka_bootstrap_servers', 'kafka_sasl_username', 'kafka_sasl_password']) expect(tf, cloud).toContain(`variable "${v}"`);
      expect(tf, cloud).toContain('KAFKA_SECURITY_PROTOCOL');
      expect(tf, cloud).not.toContain('GHK_DECLARE_TOPOLOGY');
    }
    // RabbitMQ deployments are unchanged: the external AMQP URL on Azure, Amazon MQ on AWS.
    expect(renderDeploymentTargets({ ...cfg('rust', 'axum', 'rabbitmq'), deploy: { cloud: 'azure' } }).map(f => f.content).join('\n')).toContain('variable "amqp_url"');
    expect(renderDeploymentTargets({ ...cfg('rust', 'axum', 'rabbitmq'), deploy: { cloud: 'aws' } }).map(f => f.content).join('\n')).toContain('aws_mq_broker');
  });

  it('keeps RabbitMQ for runtimes without a Kafka adapter, and documents the variables', () => {
    expect(runtimeBroker(cfg('rust', 'axum'))).toBe('rabbitmq');
    expect(brokerVariables(cfg('go', 'chi'))).toEqual(['GHK_BROKER', 'KAFKA_BOOTSTRAP_SERVERS']);
    expect(brokerEnvExample(cfg('go', 'chi'), 'amqp://x')).toContain('KAFKA_BOOTSTRAP_SERVERS=localhost:9092');
  });
});
