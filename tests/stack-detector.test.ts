import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { detectExistingStack } from '../src/core/stack-detector';
import fs from 'fs';
import path from 'path';

describe('Stack and Architecture Detector', () => {
  const testWorkspace = path.join(__dirname, '.test_workspace_detector');

  beforeAll(() => {
    fs.mkdirSync(testWorkspace, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testWorkspace, { recursive: true, force: true });
  });

  const clearWorkspace = () => {
    const files = fs.readdirSync(testWorkspace);
    for (const file of files) {
      fs.rmSync(path.join(testWorkspace, file), { recursive: true, force: true });
    }
  };

  it('should detect Java Spring Boot stack', () => {
    clearWorkspace();
    fs.writeFileSync(path.join(testWorkspace, 'pom.xml'), '<project></project>');
    
    const config = detectExistingStack(testWorkspace);
    
    expect(config.stack.language).toBe('java');
    expect(config.stack.framework).toBe('spring-boot');
    expect(config.stack.testing).toBe('junit');
  });

  it('should detect React Next.js stack with Prisma', () => {
    clearWorkspace();
    fs.writeFileSync(path.join(testWorkspace, 'package.json'), JSON.stringify({
      dependencies: {
        next: 'latest',
        prisma: 'latest'
      }
    }));
    
    const config = detectExistingStack(testWorkspace);
    
    expect(config.stack.language).toBe('javascript');
    expect(config.stack.framework).toBe('nextjs');
    expect(config.stack.orm).toBe('prisma');
    expect(config.stack.testing).toBe('vitest');
  });

  it('should detect Python Django stack', () => {
    clearWorkspace();
    fs.writeFileSync(path.join(testWorkspace, 'manage.py'), 'print("django")');
    
    const config = detectExistingStack(testWorkspace);
    
    expect(config.stack.language).toBe('python');
    expect(config.stack.framework).toBe('django');
    expect(config.stack.testing).toBe('pytest');
  });

  it('should detect Hexagonal architecture heuristic', () => {
    clearWorkspace();
    fs.writeFileSync(path.join(testWorkspace, 'package.json'), '{}');
    fs.mkdirSync(path.join(testWorkspace, 'src', 'domain'), { recursive: true });
    fs.mkdirSync(path.join(testWorkspace, 'src', 'ports'), { recursive: true });
    
    const config = detectExistingStack(testWorkspace);
    
    expect(config.architecture).toBe('hexagonal');
  });
});
