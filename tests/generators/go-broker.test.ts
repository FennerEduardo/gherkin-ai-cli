import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';
import { buildIR } from '../../src/core/ir-builder';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const ir = buildIR(parsed, 'f.feature');
const cfg = (messaging: string) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language: 'go', framework: 'chi', messaging } });
const file = (messaging: string, name: string) => generatePresets(parsed, cfg(messaging)).find(f => f.filename === name);
const goMod = (messaging: string) => [generateContracts(parsed, ir, cfg(messaging)).projectRootFile].flat().find((f: any) => f?.filename === 'go.mod')!.content;

describe('Go runtime broker adapters', () => {
  it('relay and inbox use broker-neutral ports, with RabbitMQ and Pub/Sub adapters', () => {
    const broker = file('rabbitmq', 'internal/runtime/broker.go')!.content;
    expect(broker).toContain('type RabbitMQBroker struct');
    expect(broker).toContain('type PubSubBroker struct');
    expect(broker).toContain('const DefaultBrokerKind = "rabbitmq"');
    expect(file('rabbitmq', 'internal/runtime/outbox_relay.go')!.content).not.toContain('amqp091');
    expect(file('rabbitmq', 'internal/runtime/inbox_consumer.go')!.content).not.toContain('amqp091');
    expect(file('rabbitmq', 'internal/runtime/servicebus_broker.go')).toBeUndefined();
    expect(goMod('rabbitmq')).not.toContain('azservicebus');
  });

  it('adds the Service Bus adapter and the Azure modules only for stack.messaging "servicebus"', () => {
    expect(file('servicebus', 'internal/runtime/servicebus_broker.go')!.content).toContain('type ServiceBusBroker struct');
    expect(file('servicebus', 'internal/runtime/broker.go')!.content).toContain('return NewServiceBusBrokerFromEnv()');
    expect(goMod('servicebus')).toContain('azservicebus v1.11.0');
  });
});
