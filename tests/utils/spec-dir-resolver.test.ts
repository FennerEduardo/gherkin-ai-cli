import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveSpecDir } from '../../src/utils/spec-dir-resolver';

describe('Spec Dir Resolver', () => {
  const testDir = path.join(process.cwd(), '.test-spec-dir');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.GHK_SPEC_DIR;
  });

  it('should resolve explicitly provided specDir from config', () => {
    const customDir = path.join(testDir, 'custom-specs');
    fs.mkdirSync(customDir);
    
    const resolved = resolveSpecDir('custom-specs', testDir);
    expect(resolved).toBe(customDir);
  });

  it('should resolve from env var GHK_SPEC_DIR', () => {
    const envDir = path.join(testDir, 'env-specs');
    fs.mkdirSync(envDir);
    process.env.GHK_SPEC_DIR = 'env-specs';
    
    // config param is ignored if env var is set
    const resolved = resolveSpecDir('other-dir', testDir);
    expect(resolved).toBe(envDir);
  });

  it('should auto-detect "features" directory', () => {
    const featuresDir = path.join(testDir, 'features');
    fs.mkdirSync(featuresDir);
    
    const resolved = resolveSpecDir(undefined, testDir);
    expect(resolved).toBe(featuresDir);
  });

  it('should auto-detect "specs" directory', () => {
    const specsDir = path.join(testDir, 'specs');
    fs.mkdirSync(specsDir);
    
    const resolved = resolveSpecDir(undefined, testDir);
    expect(resolved).toBe(specsDir);
  });

  it('should auto-detect "spec" directory', () => {
    const specDir = path.join(testDir, 'spec');
    fs.mkdirSync(specDir);
    
    const resolved = resolveSpecDir(undefined, testDir);
    expect(resolved).toBe(specDir);
  });

  it('should throw error if config directory does not exist', () => {
    expect(() => {
      resolveSpecDir('non-existent-dir', testDir);
    }).toThrow(/Spec directory "non-existent-dir" not found/);
  });

  it('should throw error if no directory can be auto-detected', () => {
    expect(() => {
      resolveSpecDir(undefined, testDir);
    }).toThrow(/No spec directory found/);
  });
});
