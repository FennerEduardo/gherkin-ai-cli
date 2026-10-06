/* ==========================================================================
   Infrastructure for the runtime integration tests of the golden builds:
   a private Docker network with PostgreSQL and RabbitMQ, reachable from the
   toolchain container as `postgres` and `rabbitmq` (docs/RUNTIME-KERNEL.md).
   ========================================================================== */

'use strict';

const { spawnSync } = require('child_process');

const POSTGRES_IMAGE = 'postgres:17-alpine';
const RABBITMQ_IMAGE = 'rabbitmq:4-alpine';

function docker(args) {
  const res = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(description, check, container, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    sleep(1000);
  }
  // Include the service's own log so a CI failure explains itself.
  const logs = container ? docker(['logs', '--tail', '60', container]).out : '';
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs / 1000}s${logs ? `\n--- ${description} log (last 60 lines) ---\n${logs}` : ''}`);
}

/** Starts PostgreSQL and RabbitMQ on a fresh network. Returns the env for the test container and a stop(). */
function startServices(label) {
  const id = `${label.replace(/[^a-z0-9-]/gi, '').toLowerCase()}-${Date.now().toString(36)}`;
  const network = `ghk-net-${id}`;
  const pg = `ghk-pg-${id}`;
  const mq = `ghk-mq-${id}`;
  const stop = () => {
    docker(['rm', '-f', pg, mq]);
    docker(['network', 'rm', network]);
  };
  try {
    if (docker(['network', 'create', network]).code !== 0) throw new Error(`cannot create network ${network}`);
    const pgRun = docker(['run', '-d', '--name', pg, '--network', network, '--network-alias', 'postgres', '-e', 'POSTGRES_PASSWORD=ghk', POSTGRES_IMAGE]);
    if (pgRun.code !== 0) throw new Error(`cannot start PostgreSQL: ${pgRun.out}`);
    const mqRun = docker(['run', '-d', '--name', mq, '--network', network, '--network-alias', 'rabbitmq', '-e', 'RABBITMQ_DEFAULT_USER=ghk', '-e', 'RABBITMQ_DEFAULT_PASS=ghk', RABBITMQ_IMAGE]);
    if (mqRun.code !== 0) throw new Error(`cannot start RabbitMQ: ${mqRun.out}`);
    waitFor('PostgreSQL', () => docker(['exec', pg, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']).code === 0, pg);
    // Probe as the rabbitmq user: the image sets HOME=/var/lib/rabbitmq, so a root probe that runs before
    // the server creates .erlang.cookie writes it root-only and the server then fails to start (eacces).
    waitFor('RabbitMQ', () => docker(['exec', '-u', 'rabbitmq', mq, 'rabbitmq-diagnostics', '-q', 'check_port_connectivity']).code === 0, mq);
  } catch (err) {
    stop();
    throw err;
  }
  return {
    network,
    env: {
      DATABASE_URL: 'postgres://postgres:ghk@postgres:5432/postgres',
      AMQP_URL: 'amqp://ghk:ghk@rabbitmq:5672'
    },
    stop
  };
}

module.exports = { startServices, POSTGRES_IMAGE, RABBITMQ_IMAGE };
