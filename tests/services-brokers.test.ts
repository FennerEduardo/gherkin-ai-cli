import { describe, it, expect } from 'vitest';
import { brokerServices } from '../src/core/services';
import { partialConfigSchema } from '../src/core/config/schema';

describe('verify --services brokers', () => {
  it('starts the container of each runtime broker, and none for RabbitMQ', () => {
    expect(brokerServices('rabbitmq', 'billing')).toEqual([]);
    expect(brokerServices('pubsub', 'billing').map(s => s.name)).toEqual(['pubsub']);
    expect(brokerServices('pubsub', 'billing')[0].command).toContain('pubsub');
    expect(brokerServices('kafka', 'billing')[0].env).toMatchObject({ GHK_BROKER: 'kafka', KAFKA_BOOTSTRAP_SERVERS: 'kafka:9092' });
  });

  it('declares the service topology in the Service Bus emulator, after its database', () => {
    const [sql, bus] = brokerServices('servicebus', 'billing');
    expect(sql.name).toBe('sqledge');
    const config = JSON.parse(Object.values(bus.files ?? {})[0]);
    const topics = config.UserConfig.Namespaces[0].Topics.map((t: { Name: string }) => t.Name);
    expect(topics).toEqual(expect.arrayContaining(['billing.events', 'billing.dlx', 'it.events']));
  });

  it('keeps the start command, readiness and files of sandbox.services', () => {
    const parsed = partialConfigSchema.parse({
      sandbox: { services: [{ name: 'mailpit', image: 'axllent/mailpit:v1.21', command: ['--smtp', ':1025'], ready: ['true'], readyLog: 'accessible via', files: { '/etc/x': 'y' } }] }
    });
    expect(parsed.sandbox?.services?.[0]).toMatchObject({ command: ['--smtp', ':1025'], ready: ['true'], readyLog: 'accessible via', files: { '/etc/x': 'y' } });
  });
});
