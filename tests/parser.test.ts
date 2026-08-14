/* ==========================================================================
   gherkin-ai-cli - Unit Tests for Parser, Engine & Multi-Stack Detector
   ========================================================================== */

import assert from 'assert';
import path from 'path';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { generateContracts } from '../src/generators/contracts';
import { detectExistingStack } from '../src/core/stack-detector';
import { defaultConfig } from '../src/core/config';
import { writeFileSync, removeFileSync, removeDirSync, ensureDirSync } from '../src/utils/file-system';

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

// 3. Contracts Generator Test
const { contractsTs, adrMd } = generateContracts(parsed, defaultConfig);
assert(contractsTs.includes('UserLoginFeatureCommandSchema'));
assert(adrMd.includes('ADR 001'));
console.log('✔ Contracts generator test passed!');

// 4. Stack Auto-Detector Test (Node / TS)
const detected = detectExistingStack(process.cwd());
assert.strictEqual(detected.projectMode, 'brownfield');
assert.strictEqual(detected.stack.language, 'typescript');
console.log('✔ Stack auto-detector Node/TS test passed!');

// 5. Stack Auto-Detector Test (PHP Laravel Mock)
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

// 6. Stack Auto-Detector Test (Angular / Ionic Mock)
const mockIonicDir = path.join(__dirname, 'mock-ionic');
ensureDirSync(mockIonicDir);
writeFileSync(path.join(mockIonicDir, 'angular.json'), '{}');
writeFileSync(path.join(mockIonicDir, 'package.json'), JSON.stringify({
  dependencies: { '@angular/core': '^16.0.0', '@ionic/angular': '^7.0.0' }
}));

const detectedIonic = detectExistingStack(mockIonicDir);
assert.strictEqual(detectedIonic.stack.language, 'typescript');
assert.strictEqual(detectedIonic.stack.framework, 'ionic-angular');
assert.strictEqual(detectedIonic.stack.validation, 'angular-reactive-forms');
removeDirSync(mockIonicDir);
console.log('✔ Stack auto-detector Angular/Ionic test passed!');

console.log('All tests passed successfully!');
