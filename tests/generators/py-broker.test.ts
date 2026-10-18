import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const cfg = (framework: string, messaging: string) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language: 'python', framework, orm: 'sqlalchemy', messaging } });
const files = (framework: string, messaging: string) => generatePresets(parsed, cfg(framework, messaging));
const file = (framework: string, messaging: string, name: string) => files(framework, messaging).find(f => f.filename === name);

describe('Python runtime broker adapters', () => {
  it.each(['fastapi', 'django'])('%s: relay and inbox use broker-neutral ports, with RabbitMQ and Pub/Sub adapters', framework => {
    const broker = file(framework, 'rabbitmq', 'app/runtime/broker.py')!.content;
    expect(broker).toContain('class RabbitMqBroker(Broker):');
    expect(broker).toContain('class PubSubBroker(Broker):');
    expect(broker).toContain('DEFAULT_BROKER = "rabbitmq"');
    expect(file(framework, 'rabbitmq', 'app/runtime/outbox_relay.py')!.content).not.toContain('pika');
    expect(file(framework, 'rabbitmq', 'app/runtime/inbox_consumer.py')!.content).not.toContain('pika');
    expect(file(framework, 'rabbitmq', 'app/runtime/servicebus_broker.py')).toBeUndefined();
    expect(file(framework, 'rabbitmq', 'pyproject.toml')!.content).not.toContain('azure-servicebus');
  });

  it('adds the Service Bus adapter and the Azure packages only for stack.messaging "servicebus"', () => {
    expect(file('fastapi', 'servicebus', 'app/runtime/servicebus_broker.py')!.content).toContain('class ServiceBusBroker(Broker):');
    expect(file('fastapi', 'servicebus', 'app/runtime/broker.py')!.content).toContain('from .servicebus_broker import ServiceBusBroker');
    expect(file('fastapi', 'servicebus', 'pyproject.toml')!.content).toContain('azure-servicebus');
  });
});
