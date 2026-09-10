/* ==========================================================================
   gherkin-ai-cli - Infrastructure Generator (Docker Compose & Serverless FaaS)
   ========================================================================== */

import { GherkinAIConfig } from '../core/config';

export interface StackDockerDetails {
  image: string;
  defaultCmd: string;
  testCmd: string;
}

export function getStackDockerDetails(config: GherkinAIConfig): StackDockerDetails {
  const lang = (config.stack.language || 'typescript').toLowerCase();
  const testing = (config.stack.testing || '').toLowerCase();

  switch (lang) {
    case 'csharp':
    case 'c#':
    case '.net':
    case 'dotnet':
      return {
        image: 'mcr.microsoft.com/dotnet/sdk:8.0',
        defaultCmd: 'dotnet run',
        testCmd: 'dotnet test'
      };
    case 'java':
      return {
        image: 'eclipse-temurin:21-jdk-alpine',
        defaultCmd: './gradlew bootRun',
        testCmd: './gradlew test'
      };
    case 'php':
      return {
        image: 'php:8.3-cli-alpine',
        defaultCmd: 'php -S 0.0.0.0:8000',
        testCmd: testing.includes('pest') ? 'vendor/bin/pest' : 'vendor/bin/phpunit'
      };
    case 'python':
      return {
        image: 'python:3.11-slim',
        defaultCmd: 'python main.py',
        testCmd: 'pytest'
      };
    case 'go':
    case 'golang':
      return {
        image: 'golang:1.22-alpine',
        defaultCmd: 'go run main.go',
        testCmd: 'go test ./...'
      };
    case 'ruby':
      return {
        image: 'ruby:3.3-alpine',
        defaultCmd: 'bundle exec rails s -b 0.0.0.0',
        testCmd: 'bundle exec rspec'
      };
    case 'typescript':
    case 'javascript':
    default:
      return {
        image: 'node:20-alpine',
        defaultCmd: 'npm start',
        testCmd: testing.includes('vitest') ? 'npx vitest run' : 'npm test'
      };
  }
}

export function generateInfra(config: GherkinAIConfig): { dockerComposeYaml: string; serverlessYml: string; envExample: string } {
  const db = config.stack.database || 'postgresql';
  const messaging = config.stack.messaging || 'rabbitmq';
  const dockerDetails = getStackDockerDetails(config);

  let dbImage = 'postgres:16-alpine';
  let dbEnv = `
      POSTGRES_DB: ${config.projectName}_db
      POSTGRES_USER: dev_user
      POSTGRES_PASSWORD: dev_password`;
  let dbPort = '5432:5432';

  if (db.includes('mysql') || db.includes('mariadb')) {
    dbImage = 'mysql:8.0';
    dbEnv = `
      MYSQL_DATABASE: ${config.projectName}_db
      MYSQL_ROOT_PASSWORD: root_password
      MYSQL_USER: dev_user
      MYSQL_PASSWORD: dev_password`;
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
      - ENVIRONMENT=development
      - DATABASE_URL=${db}://dev_user:dev_password@${db}:5432/${config.projectName}_db
    ports:
      - "8000:8000"
    depends_on:
      - ${db}

  # Database Service (${db})
  ${db}:
    image: ${dbImage}
    container_name: ${config.projectName}-db
    restart: always
    environment:${dbEnv}
    ports:
      - "${dbPort}"
    volumes:
      - db_data:/var/lib/data

  # Message Broker
  ${messaging}:
    image: rabbitmq:3-management-alpine
    container_name: ${config.projectName}-mq
    restart: always
    ports:
      - "5672:5672"
      - "15672:15672"

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
  runtime: nodejs18.x
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
NODE_ENV=development
PORT=3000

# Database Connection
DATABASE_URL=${db}://dev_user:dev_password@localhost:5432/${config.projectName}_db?schema=public

# Security & Authentication
JWT_SECRET=super_secret_jwt_key_change_in_production
JWT_TTL_SECONDS=${config.rules.jwtTtlSeconds || 3600}
BCRYPT_COST_FACTOR=${config.rules.bcryptCostFactor || 12}

# Serverless & Cloud Configuration
AWS_REGION=us-east-1
SERVERLESS_STAGE=dev
`;

  return { dockerComposeYaml, serverlessYml, envExample };
}
