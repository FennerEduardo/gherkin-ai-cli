import { describe, it, expect } from 'vitest';
import { generatePresets } from '../src/generators/presets';
import { GherkinAIConfig } from '../src/core/config';

describe('Distributed Multi-Stack & Frontend Matrix Combinations', () => {
  const mockParsed = {
    featureName: 'OrderManagement',
    scenarios: []
  };

  const matrixBackend = [
    { name: 'Java Spring Boot', lang: 'java', framework: 'spring-boot' },
    { name: 'C# .NET', lang: 'csharp', framework: 'dotnet-aspnetcore' },
    { name: 'Node.js NestJS', lang: 'typescript', framework: 'nestjs' }
  ];

  const matrixFrontend = [
    { name: 'Vue 3 Pinia', framework: 'vue', state: 'pinia', expectedFile: 'frontend/stores/ordermanagement.store.ts' },
    { name: 'React 18 Redux', framework: 'react', state: 'redux-toolkit', expectedFile: 'frontend/store/ordermanagementSlice.ts' },
    { name: 'Angular 17 Signals', framework: 'angular', state: 'signals', expectedFile: 'frontend/store/ordermanagement.store.ts' },
    { name: 'Angular Classic NgRx', framework: 'angular', state: 'classic', expectedFile: 'frontend/store/ordermanagement.store.ts' }
  ];

  matrixBackend.forEach(be => {
    matrixFrontend.forEach(fe => {
      it(`Generates dual-stack contract for ${be.name} + ${fe.name}`, () => {
        const config: GherkinAIConfig = {
          projectName: 'test-app',
          architecture: 'hexagonal',
          stack: {
            language: be.lang,
            framework: be.framework,
            orm: 'jpa',
            database: 'postgresql',
            validation: 'jakarta',
            auth: 'jwt',
            testing: 'junit'
          },
          frontendStack: {
            framework: fe.framework,
            language: 'typescript',
            stateManagement: fe.state
          },
          outputDir: './specs'
        };

        const files = generatePresets(mockParsed, config);
        expect(files.length).toBeGreaterThan(1);
        expect(files.some(f => f.filename === fe.expectedFile)).toBe(true);

        if (be.lang === 'csharp') {
          expect(files.some(f => f.filename.includes('AppHost/Program.cs'))).toBe(true);
          expect(files.some(f => f.filename.includes('SignalRNotificationService.cs'))).toBe(true);
          expect(files.some(f => f.filename.includes('DistributedSystemIntegrationTest.cs'))).toBe(true);
        }
      });
    });
  });
});
