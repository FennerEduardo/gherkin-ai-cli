/* ==========================================================================
   gherkin-ai-cli - Unit Tests for Parser, Engine & Multi-Language Contracts
   ========================================================================== */

import assert from 'assert';
import path from 'path';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { generateContracts } from '../src/generators/contracts';
import { detectExistingStack } from '../src/core/stack-detector';
import { defaultConfig } from '../src/core/config';
import { writeFileSync, removeFileSync, removeDirSync, ensureDirSync } from '../src/utils/file-system';
import { suggestPatterns } from '../src/core/patterns-suggester';

const sampleSpec = `Feature: User Login Feature
  As an authenticated user
  I want to login with email and password

  Scenario: Login success
    Given a user with email "test@example.com" exists
    When user submits email "test@example.com" and password "Pass123!"
    Then response is 200 OK
    And emits "UserLoggedIn" event
`;

const sampleSpanishSpec = `Característica: Autenticación de Usuarios
  Como usuario registrado
  Quiero iniciar sesión

  Escenario: Login exitoso en español
    Dado que existe un usuario registrado con email "dev@example.com"
    Cuando envío credenciales válidas con email "dev@example.com"
    Entonces el sistema responde con HTTP 200 OK
    Y emite un evento "UsuarioAutenticado"
`;

console.log('Running gherkin-ai CLI unit tests...');

// 1. English AST Test
const parsed = parseGherkinText(sampleSpec);
assert.strictEqual(parsed.featureName, 'User Login Feature');
assert.strictEqual(parsed.scenarios.length, 1);
assert.strictEqual(parsed.scenarios[0].name, 'Login success');
assert.strictEqual(parsed.scenarios[0].steps.length, 4);
console.log('✔ AST Parser English test passed!');

// 2. Spanish i18n AST Test
const parsedEs = parseGherkinText(sampleSpanishSpec);
assert.strictEqual(parsedEs.featureName, 'Autenticación de Usuarios');
assert.strictEqual(parsedEs.scenarios.length, 1);
assert.strictEqual(parsedEs.scenarios[0].steps[0].keyword, 'Given');
assert.strictEqual(parsedEs.scenarios[0].steps[1].keyword, 'When');
assert.strictEqual(parsedEs.scenarios[0].steps[2].keyword, 'Then');
assert.strictEqual(parsedEs.scenarios[0].steps[3].keyword, 'And');
console.log('✔ AST Parser Spanish (i18n) test passed!');

// 3. Contracts Generator Test (TypeScript)
const { contractsTs, adrMd } = generateContracts(parsed, defaultConfig);
assert(contractsTs.includes('UserLoginFeatureCommandSchema'));
assert(adrMd.includes('ADR 001'));
console.log('✔ Contracts generator TypeScript test passed!');

// 4. Multi-Language Contracts Test (Python, PHP, Go, C#)
const pythonConfig = { ...defaultConfig, stack: { ...defaultConfig.stack, language: 'python' } };
const { nativeContract: pyContract } = generateContracts(parsed, pythonConfig);
assert(pyContract?.filename === 'userloginfeature.contract.py');
assert(pyContract?.content.includes('class UserLoginFeatureCommand(BaseModel)'));
console.log('✔ Contracts generator Python (Pydantic) test passed!');

const phpConfig = { ...defaultConfig, stack: { ...defaultConfig.stack, language: 'php' } };
const { nativeContract: phpContract } = generateContracts(parsed, phpConfig);
assert(phpContract?.filename === 'userloginfeature.contract.php');
assert(phpContract?.content.includes('readonly class UserLoginFeatureCommand'));
console.log('✔ Contracts generator PHP 8.2 test passed!');

// 5. Stack Auto-Detector Test (Node / TS)
const detected = detectExistingStack(process.cwd());
assert.strictEqual(detected.projectMode, 'brownfield');
assert.strictEqual(detected.stack.language, 'typescript');
console.log('✔ Stack auto-detector Node/TS test passed!');

// 6. Stack Auto-Detector Test (PHP Laravel Mock)
const mockLaravelDir = path.join(__dirname, 'mock-laravel');
ensureDirSync(mockLaravelDir);
writeFileSync(path.join(mockLaravelDir, 'artisan'), '#!/usr/bin/env php\n');
writeFileSync(path.join(mockLaravelDir, 'composer.json'), JSON.stringify({ name: 'company/sim-rest' }));

const detectedLaravel = detectExistingStack(mockLaravelDir);
assert.strictEqual(detectedLaravel.stack.language, 'php');
assert.strictEqual(detectedLaravel.stack.framework, 'laravel');
assert.strictEqual(detectedLaravel.stack.orm, 'eloquent');
removeDirSync(mockLaravelDir);
console.log('✔ Stack auto-detector Laravel/PHP test passed!');

// 7. Closed-Loop Execution Sandbox & Error Parser Test
import { executeSandbox } from '../src/core/execution-sandbox';
import { parseExecutionFailure } from '../src/core/error-parser';

const sandboxResult = executeSandbox({ command: 'node -e "console.error(\\\"Error: AssertionError at src/app.ts:12\\\"); process.exit(1)"' });
assert.strictEqual(sandboxResult.success, false);
const diagnosis = parseExecutionFailure(sandboxResult);
assert(diagnosis.affectedFiles.includes('src/app.ts'));
console.log('✔ Closed-Loop Execution Sandbox & Error Parser test passed!');

// 8. Context Builder & Guardrails Test
import { buildProjectContext } from '../src/core/context-builder';
import { validateGuardrails } from '../src/core/guardrails';

const ctx = buildProjectContext();
assert(ctx.detectedFiles.length > 0);
const guardRes = validateGuardrails(['src/index.ts']);
assert.strictEqual(guardRes.allowed, true);
const guardViolation = validateGuardrails(['infrastructure/db.tf']);
assert.strictEqual(guardViolation.allowed, false);
console.log('✔ Context Builder & Guardrails Policy Engine test passed!');

// 9. Enterprise Presets Test (Java Spring & React Playwright)
import { generateJavaSpringPreset } from '../src/generators/preset-java-spring';
import { generateReactPlaywrightPreset } from '../src/generators/preset-react-playwright';

const javaPreset = generateJavaSpringPreset(parsed);
assert(javaPreset[0].content.includes('Cucumber-JVM'));
const reactPreset = generateReactPlaywrightPreset(parsed);
assert(reactPreset[0].content.includes('@playwright/test'));
console.log('✔ Enterprise Presets (Java Spring & React Playwright) test passed!');

// 10. Quality Score Engine Test
import { calculateQualityScorecard } from '../src/core/quality-score';
const scorecard = calculateQualityScorecard();
assert.strictEqual(scorecard.passedQualityGate, true);
console.log('✔ Quality Score Engine test passed!');

// 11. Patterns Suggester Test
const mockReactStack = { framework: 'react', language: 'typescript' };
const suggestions = suggestPatterns(mockReactStack, 'clean');
assert(suggestions.designPatterns.includes('Hooks Pattern'));
assert(suggestions.designPatterns.includes('Repository Pattern'));
assert(suggestions.codingRules.some(rule => rule.includes('avoid "any"')));
console.log('✔ Patterns Suggester test passed!');

console.log('All tests passed successfully!');

