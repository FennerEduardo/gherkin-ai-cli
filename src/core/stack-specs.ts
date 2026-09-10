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
  const lang = (stackConfig.language || 'typescript').toLowerCase();
  const framework = (stackConfig.framework || 'nestjs').toLowerCase();
  const orm = (stackConfig.orm || 'prisma').toLowerCase();
  const validation = (stackConfig.validation || 'zod').toLowerCase();
  const testing = (stackConfig.testing || 'jest').toLowerCase();

  let frameworkVersion = '^10.3.0';
  let ormPackage = '@prisma/client@^5.10.0';
  let validationPackage = 'zod@^3.22.4';
  let testPackages = ['jest@^29.7.0', 'supertest@^6.3.4'];

  if (lang === 'php') {
    frameworkVersion = framework === 'native-php' ? 'PHP 8.3 Native' : 'composer/framework ^10.0';
    ormPackage = orm === 'pdo' ? 'ext-pdo (PDO Native)' : (orm === 'eloquent' ? 'illuminate/database ^10.0' : 'doctrine/orm ^3.0');
    validationPackage = validation === 'native-php-filter' ? 'ext-filter (filter_var)' : (validation === 'valitron' ? 'vlucas/valitron ^1.4' : 'symfony/validator ^7.0');
    testPackages = testing === 'phpunit' ? ['phpunit/phpunit ^10.5'] : ['pestphp/pest ^2.0'];
  } else if (lang === 'python') {
    frameworkVersion = 'Python 3.11+';
    ormPackage = orm === 'sqlalchemy' ? 'SQLAlchemy^2.0.0' : 'django^5.0.0';
    validationPackage = validation === 'pydantic' ? 'pydantic^2.6.0' : 'marshmallow^3.20.0';
    testPackages = testing === 'pytest' ? ['pytest^8.0.0', 'pytest-asyncio'] : ['unittest (standard library)'];
  } else if (lang === 'java') {
    frameworkVersion = 'Java 17/21 (Spring Boot 3.2)';
    ormPackage = 'org.hibernate.orm:hibernate-core:6.4.4.Final';
    validationPackage = 'jakarta.validation:jakarta.validation-api:3.0.2';
    testPackages = testing === 'junit' ? ['org.junit.jupiter:junit-jupiter:5.10.2'] : ['org.testng:testng:7.9.0'];
  } else if (lang === 'csharp') {
    frameworkVersion = '.NET 8.0';
    ormPackage = orm === 'entity-framework-core' ? 'Microsoft.EntityFrameworkCore 8.0' : 'Dapper 2.1';
    validationPackage = 'FluentValidation 11.9';
    testPackages = testing === 'xunit' ? ['xunit 2.7.0'] : ['NUnit 4.1'];
  } else if (lang === 'go') {
    frameworkVersion = 'Go 1.22+';
    ormPackage = 'gorm.io/gorm v1.25.7';
    validationPackage = 'github.com/go-playground/validator/v10';
    testPackages = testing === 'testing' ? ['testing (standard library)'] : ['github.com/onsi/ginkgo/v2'];
  } else if (lang === 'ruby') {
    frameworkVersion = 'Ruby 3.3+';
    ormPackage = 'active_record ^7.1';
    validationPackage = 'active_model';
    testPackages = testing === 'rspec' ? ['rspec-rails ^6.1'] : ['minitest'];
  } else {
    // TypeScript / JavaScript
    if (testing === 'vitest') {
      testPackages = ['vitest@^1.3.0', '@vitest/coverage-v8'];
    }
  }

  return {
    language: lang,
    framework,
    frameworkVersion,
    orm,
    ormPackage,
    validation,
    validationPackage,
    auth: stackConfig.auth || 'jwt-bcrypt',
    authPackages: lang === 'php' ? ['firebase/php-jwt ^6.10'] : ['@nestjs/jwt@^10.2.0', 'bcrypt@^5.1.1'],
    bcryptCostFactor: stackConfig.bcryptCostFactor || 12,
    jwtTtlSeconds: stackConfig.jwtTtlSeconds || 3600,
    messaging: stackConfig.messaging || 'none',
    messagingPackage: stackConfig.messaging === 'rabbitmq' ? 'amqplib@^0.10.3' : 'none',
    testing,
    testPackages
  };
}
