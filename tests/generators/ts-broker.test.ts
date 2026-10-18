import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';
import { buildIR } from '../../src/core/ir-builder';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const ir = buildIR(parsed, 'f.feature');
const cfg = (framework: string, messaging: string) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language: 'typescript', framework, messaging } });
const file = (files: { filename: string; content: string }[], name: string) => files.find(f => f.filename === name);
const pkg = (config: any) => JSON.parse((generateContracts(parsed, ir, config).projectRootFile as { content: string }).content);

describe('TypeScript runtime broker adapters', () => {
  it.each(['nestjs', 'express'])('%s: relay and inbox use broker-neutral ports, with RabbitMQ and Pub/Sub adapters', framework => {
    const files = generatePresets(parsed, cfg(framework, 'rabbitmq'));
    const broker = file(files, 'src/runtime/broker.ts')!.content;
    expect(broker).toContain('export class RabbitMqBroker');
    expect(broker).toContain('export class PubSubBroker');
    expect(broker).toContain("export const DEFAULT_BROKER = 'rabbitmq'");
    expect(file(files, 'src/runtime/outbox-relay.ts')!.content).not.toContain('amqplib');
    expect(file(files, 'src/runtime/inbox-consumer.ts')!.content).not.toContain('amqplib');
    expect(file(files, 'src/runtime/servicebus-broker.ts')).toBeUndefined();
    expect(Object.keys(pkg(cfg(framework, 'rabbitmq')).dependencies)).not.toContain('@azure/service-bus');
  });

  it('defaults to Pub/Sub for stack.messaging "pubsub"', () => {
    expect(file(generatePresets(parsed, cfg('nestjs', 'pubsub')), 'src/runtime/broker.ts')!.content).toContain("export const DEFAULT_BROKER = 'pubsub'");
  });

  it('adds the Service Bus adapter and the Azure packages only for stack.messaging "servicebus"', () => {
    const files = generatePresets(parsed, cfg('nestjs', 'servicebus'));
    expect(file(files, 'src/runtime/servicebus-broker.ts')!.content).toContain('export class ServiceBusBroker');
    expect(file(files, 'src/runtime/broker.ts')!.content).toContain("import { ServiceBusBroker } from './servicebus-broker'");
    expect(pkg(cfg('nestjs', 'servicebus')).dependencies).toMatchObject({ '@azure/service-bus': expect.any(String), '@azure/identity': expect.any(String) });
  });

  it('NestJS 12 (ES modules) imports the broker modules with .js extensions', () => {
    const config = { ...cfg('nestjs', 'servicebus'), stack: { ...cfg('nestjs', 'servicebus').stack, frameworkVersion: '12' } };
    const broker = file(generatePresets(parsed, config), 'src/runtime/broker.ts')!.content;
    expect(broker).toContain("from './servicebus-broker.js'");
  });
});
