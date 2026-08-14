/* ==========================================================================
   gherkin-ai-cli - Technical Stack Specifications & Package Versions
   ========================================================================== */

export interface StackSpec {
  language: string;
  framework: string;
  frameworkVersion: string;
  orm: string;
  ormPackage: string;
  validation: string;
  validationPackage: string;
  auth: string;
  authPackages: string[];
  bcryptCostFactor: number;
  jwtTtlSeconds: number;
  messaging?: string;
  messagingPackage?: string;
  testing: string;
  testPackages: string[];
}

export function getStackSpec(stackConfig: Record<string, any>): StackSpec {
  return {
    language: stackConfig.language || 'typescript',
    framework: stackConfig.framework || 'nestjs',
    frameworkVersion: '^10.3.0',
    orm: stackConfig.orm || 'prisma',
    ormPackage: '@prisma/client@^5.10.0',
    validation: stackConfig.validation || 'zod',
    validationPackage: 'zod@^3.22.4',
    auth: stackConfig.auth || 'jwt-bcrypt',
    authPackages: ['@nestjs/jwt@^10.2.0', '@nestjs/passport@^10.0.3', 'bcrypt@^5.1.1', 'passport-jwt@^4.0.1'],
    bcryptCostFactor: stackConfig.bcryptCostFactor || 12,
    jwtTtlSeconds: stackConfig.jwtTtlSeconds || 3600,
    messaging: stackConfig.messaging || 'rabbitmq',
    messagingPackage: 'amqplib@^0.10.3',
    testing: stackConfig.testing || 'jest',
    testPackages: ['jest@^29.7.0', '@types/jest@^29.5.12', 'ts-jest@^29.1.2', 'supertest@^6.3.4']
  };
}
