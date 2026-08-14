/* ==========================================================================
   gherkin-ai-cli - Infrastructure & Docker Compose Generator
   ========================================================================== */

import { GherkinAIConfig } from '../core/config';

export function generateInfra(config: GherkinAIConfig): { dockerComposeYaml: string; envExample: string } {
  const db = config.stack.database || 'postgresql';
  const messaging = config.stack.messaging || 'rabbitmq';

  const dockerComposeYaml = `version: '3.8'

services:
  # Database Service
  ${db}:
    image: postgres:16-alpine
    container_name: ${config.projectName}-db
    restart: always
    environment:
      POSTGRES_DB: ${config.projectName}_db
      POSTGRES_USER: dev_user
      POSTGRES_PASSWORD: dev_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

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
  postgres_data:
`;

  const envExample = `# Environment Variables for ${config.projectName}
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=postgresql://dev_user:dev_password@localhost:5432/${config.projectName}_db?schema=public

# Security & JWT
JWT_SECRET=super_secret_jwt_key_change_in_production
JWT_TTL_SECONDS=${config.rules.jwtTtlSeconds || 3600}
BCRYPT_COST_FACTOR=${config.rules.bcryptCostFactor || 12}

# Messaging & Redis
RABBITMQ_URL=amqp://localhost:5672
REDIS_URL=redis://localhost:6379
`;

  return { dockerComposeYaml, envExample };
}
