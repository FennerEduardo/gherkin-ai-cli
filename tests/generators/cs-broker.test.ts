import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';
import { buildIR } from '../../src/core/ir-builder';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const ir = buildIR(parsed, 'f.feature');
const cfg = (messaging: string) => ({ ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language: 'csharp', framework: 'dotnet-aspnetcore', orm: 'efcore', messaging } });
const file = (messaging: string, name: string) => generatePresets(parsed, cfg(messaging)).find(f => f.filename === name);
const csproj = (messaging: string) => [generateContracts(parsed, ir, cfg(messaging)).projectRootFile].flat().find((f: any) => f?.filename.endsWith('.csproj'))!.content;

describe('.NET runtime broker adapters', () => {
  it('relay and inbox use broker-neutral ports, with RabbitMQ and Pub/Sub adapters', () => {
    const brokers = file('rabbitmq', 'src/Runtime/Brokers.cs')!.content;
    expect(brokers).toContain('public sealed class RabbitMqBroker');
    expect(brokers).toContain('public sealed class PubSubBroker');
    expect(brokers).toContain('public const string DefaultKind = "rabbitmq"');
    expect(file('rabbitmq', 'src/Runtime/OutboxRelay.cs')!.content).not.toContain('RabbitMQ.Client');
    expect(file('rabbitmq', 'src/Runtime/InboxConsumer.cs')!.content).not.toContain('RabbitMQ.Client');
    expect(file('rabbitmq', 'src/Runtime/ServiceBusBroker.cs')).toBeUndefined();
    expect(csproj('rabbitmq')).not.toContain('Azure.Messaging.ServiceBus');
  });

  it('adds the Service Bus adapter and the Azure packages only for stack.messaging "servicebus"', () => {
    expect(file('servicebus', 'src/Runtime/ServiceBusBroker.cs')!.content).toContain('public sealed class ServiceBusBroker : IBroker');
    expect(file('servicebus', 'src/Runtime/Brokers.cs')!.content).toContain('(IBroker)ServiceBusBroker.FromEnv()');
    expect(csproj('servicebus')).toContain('Azure.Messaging.ServiceBus');
    expect(csproj('servicebus')).toContain('Azure.Identity');
  });
});
