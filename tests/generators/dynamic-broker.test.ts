import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const files = (language: string, framework: string, messaging: string) =>
  generatePresets(parsed, { ...defaultConfig, stack: { ...defaultConfig.stack, language, framework, messaging } });
const content = (language: string, framework: string, messaging: string, match: (name: string) => boolean) =>
  files(language, framework, messaging).find(f => match(f.filename))!.content;

// Ruby, Elixir and PHP: RabbitMQ or Pub/Sub (no official Service Bus SDK; on Azure they use RabbitMQ).
describe('Ruby, Elixir and PHP runtime broker adapters', () => {
  it('Ruby: EventBroker selects RabbitMQ or Pub/Sub; servicebus keeps RabbitMQ', () => {
    const broker = (messaging: string) => content('ruby', 'rails', messaging, n => n === 'app/runtime/event_broker.rb');
    expect(broker('pubsub')).toContain('DEFAULT_KIND = "pubsub"');
    expect(broker('servicebus')).toContain('DEFAULT_KIND = "rabbitmq"');
    expect(files('ruby', 'rails', 'rabbitmq').map(f => f.filename)).toContain('app/runtime/pub_sub_broker.rb');
  });

  it('Elixir: Broker selects RabbitMQ or Pub/Sub over :httpc', () => {
    const broker = (messaging: string) => content('elixir', 'phoenix', messaging, n => n.endsWith('/runtime/broker.ex'));
    expect(broker('pubsub')).toContain('@default_kind "pubsub"');
    expect(broker('servicebus')).toContain('@default_kind "rabbitmq"');
    expect(broker('rabbitmq')).toContain(':httpc');
  });

  it('PHP: relay and inbox use the broker ports, with RabbitMQ and Pub/Sub adapters', () => {
    const php = (messaging: string, name: string) => content('php', 'laravel', messaging, n => n === name);
    expect(php('pubsub', 'app/Runtime/Brokers.php')).toContain("DEFAULT_KIND = 'pubsub'");
    expect(php('servicebus', 'app/Runtime/Brokers.php')).toContain("DEFAULT_KIND = 'rabbitmq'");
    expect(php('rabbitmq', 'app/Runtime/PubSubBroker.php')).toContain('final class PubSubBroker implements Broker');
    expect(php('rabbitmq', 'app/Runtime/OutboxRelay.php')).not.toContain('PhpAmqpLib');
    expect(php('rabbitmq', 'app/Runtime/InboxConsumer.php')).not.toContain('PhpAmqpLib');
    expect(php('rabbitmq', 'app/Console/Commands/OutboxRelayCommand.php')).toContain('Brokers::connect()');
  });
});
