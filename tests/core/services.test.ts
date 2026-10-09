import { describe, it, expect } from 'vitest';
import { startServices } from '../../src/core/services';
import { dockerRunArgs } from '../../src/core/execution-sandbox';

describe('integration services', () => {
  it('starts PostgreSQL, RabbitMQ and extra services on one network and returns their URLs', () => {
    const calls: string[][] = [];
    const docker = (args: string[]) => { calls.push(args); return { code: 0, out: '' }; };
    const s = startServices('Shop', [{ name: 'minio', image: 'minio/minio', environment: { MINIO_ROOT_USER: 'u' }, env: { S3_ENDPOINT: 'http://minio:9000' } }], { docker });

    expect(s.env).toEqual({
      DATABASE_URL: 'postgres://postgres:ghk@postgres:5432/postgres',
      AMQP_URL: 'amqp://ghk:ghk@rabbitmq:5672',
      S3_ENDPOINT: 'http://minio:9000'
    });
    const runs = calls.filter(c => c[0] === 'run');
    expect(runs.map(r => r[r.length - 1])).toEqual(['postgres:17-alpine', 'rabbitmq:4-alpine', 'minio/minio']);
    for (const r of runs) expect(r).toContain(s.network);
    // The RabbitMQ readiness probe runs as the rabbitmq user (a root probe breaks .erlang.cookie).
    expect(calls.some(c => c[0] === 'exec' && c[1] === '-u' && c[2] === 'rabbitmq')).toBe(true);

    s.stop();
    expect(calls.some(c => c[0] === 'network' && c[1] === 'rm' && c[2] === s.network)).toBe(true);
  });

  it('cleans up when a service cannot start', () => {
    const calls: string[][] = [];
    const docker = (args: string[]) => { calls.push(args); return { code: args[0] === 'run' && args.includes('rabbitmq:4-alpine') ? 1 : 0, out: 'boom' }; };
    expect(() => startServices('x', [], { docker })).toThrow(/RabbitMQ/);
    expect(calls.some(c => c[0] === 'rm')).toBe(true);
  });

  it('passes the service URLs to the test container', () => {
    const args = dockerRunArgs('/p', 'maven', 'mvn test', { network: 'ghk-net-1' }, { DATABASE_URL: 'postgres://x' });
    expect(args.join(' ')).toContain('--network ghk-net-1');
    expect(args.join(' ')).toContain('-e DATABASE_URL=postgres://x');
  });
});
