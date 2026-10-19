import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';
import { renderRustProject } from '../../src/generators/kernel/rust';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const cfg = (messaging: string) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language: 'rust', framework: 'axum', messaging } });
const file = (messaging: string, name: string) => generatePresets(parsed, cfg(messaging)).find(f => f.filename === name);

describe('Rust runtime broker adapters', () => {
  it('relay and inbox use the broker enums, with RabbitMQ and Pub/Sub adapters', () => {
    const broker = file('rabbitmq', 'src/runtime/broker.rs')!.content;
    expect(broker).toContain('pub enum Broker');
    expect(broker).toContain('pub struct PubSubBroker');
    expect(broker).toContain('pub const DEFAULT_BROKER: &str = "rabbitmq"');
    expect(file('rabbitmq', 'src/runtime/outbox_relay.rs')!.content).not.toContain('lapin');
    expect(file('rabbitmq', 'src/runtime/inbox_consumer.rs')!.content).not.toContain('lapin');
    expect(file('rabbitmq', 'Cargo.toml')!.content).toContain('reqwest');
  });

  it('defaults to Pub/Sub for "pubsub" and keeps RabbitMQ for "servicebus" (no official Rust SDK)', () => {
    expect(file('pubsub', 'src/runtime/broker.rs')!.content).toContain('pub const DEFAULT_BROKER: &str = "pubsub"');
    expect(file('servicebus', 'src/runtime/broker.rs')!.content).toContain('pub const DEFAULT_BROKER: &str = "rabbitmq"');
  });

  it('the runtime command service applies every feature the HTTP layer routes', () => {
    const refund = buildDomainModel(parseGherkinText(['Feature: Refund', '  Scenario: Refund', '    When the agent refunds the order', '    Then the refund is issued'].join('\n')));
    const service = renderRustProject(buildDomainModel(parsed), 'app', 'features/order.feature', [refund])
      .find(f => f.filename === 'src/runtime/command_service.rs')!.content;
    expect(service).toContain('"OrderCheckout" => apply_order_checkout');
    expect(service).toContain('"Refund" => apply_refund');
  });
});
