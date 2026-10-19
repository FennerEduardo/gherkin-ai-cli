/* ==========================================================================
   gherkin-ai-cli - Infrastructure Generator (Docker Compose & Serverless FaaS)
   ========================================================================== */

import { GherkinAIConfig } from '../core/config';
import { resolveAppRuntimeEnv, resolveToolchain } from './toolchains';
import { brokerEnvExample, runtimeBroker } from './deploy/broker-env';
import { frameworkVariables } from './deploy/context';

const FRAMEWORK_EXAMPLES: Record<string, string> = {
  APP_KEY: '<base64:32-random-bytes, php artisan key:generate --show>',
  SECRET_KEY_BASE: '<64+ random characters>',
  DJANGO_SECRET_KEY: '<50+ random characters>',
  DJANGO_ALLOWED_HOSTS: 'localhost'
};

export interface StackDockerDetails {
  image: string;
  defaultCmd: string;
  testCmd: string;
}

/** Image and commands for the stack, from the verified toolchain registry (toolchains.ts). */
export function getStackDockerDetails(config: GherkinAIConfig): StackDockerDetails {
  const toolchain = resolveToolchain(config);
  if (!toolchain) return { image: 'node:24-bookworm', defaultCmd: 'npm start', testCmd: 'npm test' };
  return { image: toolchain.image, defaultCmd: toolchain.start, testCmd: toolchain.test.join(' && ') };
}

export function generateInfra(config: GherkinAIConfig): { dockerComposeYaml: string; serverlessYml: string; envExample: string } {
  const db = config.stack.database || 'postgresql';
  const messaging = config.stack.messaging || 'rabbitmq';
  const dockerDetails = getStackDockerDetails(config);

  let dbImage = 'postgres:16-alpine';
  let dbEnv = `
      POSTGRES_DB: \${POSTGRES_DB:-${config.projectName}_db}
      POSTGRES_USER: \${POSTGRES_USER:-dev_user}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-dev_password}`;
  let dbPort = '5432:5432';

  const runtime = resolveAppRuntimeEnv(config);
  const dbName = `${config.projectName}_db`;
  // The runtime kernel reads DATABASE_URL and AMQP_URL in every stack.
  const databaseUrl = (host: string) =>
    db.includes('mongo') ? `mongodb://dev_user:dev_password@${host}:27017/${dbName}?authSource=admin` :
    db.includes('mysql') || db.includes('mariadb') ? `mysql://dev_user:dev_password@${host}:3306/${dbName}` :
    `postgresql://dev_user:dev_password@${host}:5432/${dbName}`;
  // RabbitMQ only lets `guest` in from localhost, so compose creates a dev user.
  const amqpUrl = (host: string) => `amqp://dev_user:dev_password@${host}:5672`;
  // Cloud brokers (Pub/Sub, Service Bus) run as the runtime kernel's adapter (deploy/broker-env.ts): compose starts
  // the Pub/Sub emulator, RabbitMQ where the stack has no Service Bus adapter, and nothing for Service Bus (its
  // emulator needs SQL Edge and a fixed entity file: point SERVICEBUS_CONNECTION_STRING at a namespace or emulator).
  const broker = runtimeBroker(config);
  const cloudBroker = /pub-?sub|service-?bus/i.test(messaging);
  const brokerService = cloudBroker ? (broker === 'servicebus' ? undefined : broker) : messaging;
  const hasBroker = !['none', 'native-events'].includes(messaging) && brokerService !== undefined;
  const appBrokerEnv = broker === 'pubsub' && cloudBroker
    ? ['GHK_BROKER=pubsub', 'PUBSUB_PROJECT_ID=${PUBSUB_PROJECT_ID:-local-project}', 'PUBSUB_EMULATOR_HOST=${PUBSUB_EMULATOR_HOST:-pubsub:8085}']
    : broker === 'servicebus'
      ? ['GHK_BROKER=servicebus', 'SERVICEBUS_CONNECTION_STRING=${SERVICEBUS_CONNECTION_STRING:-}']
      : messaging === 'rabbitmq' || cloudBroker ? [`AMQP_URL=\${AMQP_URL:-${amqpUrl('rabbitmq')}}`] : [];
  const brokerImage = brokerService === 'pubsub' ? 'gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators'
    : messaging === 'sqs' ? 'localstack/localstack' : messaging === 'kafka' ? 'confluentinc/cp-kafka' : 'rabbitmq:4-management-alpine';
  const isRabbit = brokerService === 'rabbitmq';

  if (db.includes('mysql') || db.includes('mariadb')) {
    dbImage = 'mysql:8.0';
    dbEnv = `
      MYSQL_DATABASE: \${MYSQL_DATABASE:-${config.projectName}_db}
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:-root_password}
      MYSQL_USER: \${MYSQL_USER:-dev_user}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD:-dev_password}`;
    dbPort = '3306:3306';
  } else if (db.includes('mongo')) {
    dbImage = 'mongo:7.0';
    dbEnv = `
      MONGO_INITDB_ROOT_USERNAME: dev_user
      MONGO_INITDB_ROOT_PASSWORD: dev_password`;
    dbPort = '27017:27017';
  }

  const dockerComposeYaml = `version: '3.8'

services:
  # Host Environment SDK Isolation Sandbox
  app:
    image: ${dockerDetails.image}
    container_name: ${config.projectName}-app
    volumes:
      - .:/app
    working_dir: /app
    environment:
${Object.entries(runtime.vars).map(([k, v]) => `      - ${k}=${v}`).join('\n')}
      - DATABASE_URL=\${DATABASE_URL:-${databaseUrl(db)}}${appBrokerEnv.map(e => `
      - ${e}`).join('')}
    ports:
      - "${runtime.port}:${runtime.port}"
    depends_on:
      - ${db}${hasBroker ? `
      - ${brokerService}` : ''}

  # Database Service (${db})
  ${db}:
    image: ${dbImage}
    container_name: ${config.projectName}-db
    restart: always
    environment:${dbEnv}
    ports:
      - "${dbPort}"
    volumes:
      - db_data:${db.includes('postgres') ? '/var/lib/postgresql/data' : (db.includes('mongo') ? '/data/db' : '/var/lib/mysql')}

  ${!hasBroker ? '' : `
  # Message Broker
  ${brokerService}:
    image: ${brokerImage}
    container_name: ${config.projectName}-mq
    restart: always${isRabbit ? `
    environment:
      RABBITMQ_DEFAULT_USER: \${RABBITMQ_DEFAULT_USER:-dev_user}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_DEFAULT_PASS:-dev_password}` : ''}${brokerService === 'pubsub' ? `
    command: ["gcloud", "beta", "emulators", "pubsub", "start", "--host-port=0.0.0.0:8085", "--project=local-project"]` : ''}
    ports:
      - "${brokerService === 'pubsub' ? '8085:8085' : messaging === 'sqs' ? '4566:4566' : (messaging === 'kafka' ? '9092:9092' : '5672:5672')}"
      ${isRabbit ? '- "15672:15672"' : ''}
  `}

  # Redis Cache
  redis:
    image: redis:7-alpine
    container_name: ${config.projectName}-redis
    ports:
      - "6379:6379"

volumes:
  db_data:
`;

  const serverlessYml = `service: ${config.projectName}-faas

frameworkVersion: '3'

provider:
  name: aws
  runtime: nodejs22.x
  region: us-east-1
  memorySize: 512
  timeout: 10
  environment:
    NODE_ENV: production
    DATABASE_URL: \${env:DATABASE_URL}
    JWT_SECRET: \${env:JWT_SECRET}

plugins:
  - serverless-offline
  - serverless-plugin-typescript

functions:
  api:
    handler: src/lambda.handler
    events:
      - httpApi:
          path: '/{proxy+}'
          method: '*'
`;

  const envExample = `# Environment Variables for ${config.projectName}
${Object.entries(runtime.vars).map(([k, v]) => `${k}=${v}`).join('\n')}

# Database and message broker (read by the runtime kernel)
DATABASE_URL=${databaseUrl('localhost')}
${brokerEnvExample(config, amqpUrl('localhost'))}${messaging === 'kafka' ? '\nKAFKA_BROKERS=localhost:9092' : ''}

# Security & Authentication
JWT_SECRET=<YOUR_SUPER_SECRET_JWT_KEY_MIN_32_CHARS>
JWT_TTL_SECONDS=${config.rules.jwtTtlSeconds || 3600}
BCRYPT_COST_FACTOR=${config.rules.bcryptCostFactor || 12}
${frameworkVariables(config).length ? `
# Framework settings of the production image (from the platform secret manager in a deployment)
${frameworkVariables(config).map(v => `${v}=${FRAMEWORK_EXAMPLES[v] ?? '<value>'}`).join('\n')}
` : ''}
# Serverless & Cloud Configuration
AWS_REGION=us-east-1
SERVERLESS_STAGE=dev
`;

  return { dockerComposeYaml, serverlessYml, envExample };
}
