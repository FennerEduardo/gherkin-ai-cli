import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { generateInfra } from '../../src/generators/infra';
import { renderContainerFiles } from '../../src/generators/deploy/container';
import { runtimeBroker } from '../../src/generators/deploy/broker-env';

const cfg = (language: string, framework: string, messaging: string) =>
  ({ ...defaultConfig, projectName: 'svc', stack: { ...defaultConfig.stack, language, framework, messaging, database: 'postgresql' } });

describe('broker configuration of the generated service', () => {
  it('RabbitMQ keeps AMQP_URL and the rabbitmq compose service', () => {
    const { dockerComposeYaml, envExample } = generateInfra(cfg('java', 'quarkus', 'rabbitmq'));
    expect(dockerComposeYaml).toContain('AMQP_URL=${AMQP_URL:-amqp://dev_user:dev_password@rabbitmq:5672}');
    expect(dockerComposeYaml).toContain('rabbitmq:4-management-alpine');
    expect(envExample).toContain('AMQP_URL=amqp://dev_user:dev_password@localhost:5672');
  });

  it('Pub/Sub runs the emulator in compose and documents its variables', () => {
    const config = cfg('java', 'quarkus', 'pubsub');
    const { dockerComposeYaml, envExample } = generateInfra(config);
    expect(dockerComposeYaml).toContain('google-cloud-cli:emulators');
    expect(dockerComposeYaml).toContain('PUBSUB_EMULATOR_HOST=${PUBSUB_EMULATOR_HOST:-pubsub:8085}');
    expect(dockerComposeYaml).not.toContain('rabbitmq:4-management-alpine');
    expect(envExample).toContain('GHK_BROKER=pubsub');
    expect(envExample).not.toContain('AMQP_URL');
    const dockerfile = renderContainerFiles(config).find(f => f.filename === 'Dockerfile')!.content;
    expect(dockerfile).toContain('DATABASE_URL, GHK_BROKER, PUBSUB_PROJECT_ID, JWT_SECRET');
  });

  it('Service Bus has no compose broker; stacks without an adapter keep RabbitMQ', () => {
    const go = generateInfra(cfg('go', 'chi', 'servicebus'));
    expect(go.envExample).toContain('SERVICEBUS_NAMESPACE=');
    expect(go.dockerComposeYaml).toContain('GHK_BROKER=servicebus');
    expect(go.dockerComposeYaml).not.toContain('-mq');
    expect(runtimeBroker(cfg('php', 'laravel', 'servicebus'))).toBe('rabbitmq');
    expect(generateInfra(cfg('php', 'laravel', 'servicebus')).dockerComposeYaml).toContain('rabbitmq:4-management-alpine');
  });
});
