import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { 
  generateConstitution, 
  loadConstitution, 
  getConstitutionDir,
  getAgentPermissions,
  getConstraintsByLevel,
  isLLMProviderAllowed
} from '../../src/core/constitution';

describe('Constitution Engine', () => {
  const testDir = path.join(process.cwd(), '.test-constitution');
  
  beforeEach(() => {
    // Setup a clean test directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }
    // Mock process.cwd to return our test directory
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('generateConstitution()', () => {
    it('should create the .gherkin-ai directory structure', () => {
      generateConstitution();
      
      const baseDir = getConstitutionDir();
      expect(fs.existsSync(baseDir)).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'policies'))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'agents'))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'constitution.yaml'))).toBe(true);
    });

    it('should generate default agent configurations', () => {
      generateConstitution();
      
      const baseDir = getConstitutionDir();
      expect(fs.existsSync(path.join(baseDir, 'agents', 'domain-agent.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'agents', 'backend-agent.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'agents', 'qa-agent.yaml'))).toBe(true);
    });

    it('should not overwrite existing constitution.yaml', () => {
      generateConstitution();
      
      const constitutionPath = path.join(getConstitutionDir(), 'constitution.yaml');
      const originalContent = fs.readFileSync(constitutionPath, 'utf8');
      
      // Modify the file
      fs.writeFileSync(constitutionPath, originalContent + '\n# Modified');
      
      // Generate again
      generateConstitution();
      
      // Check it wasn't overwritten
      const newContent = fs.readFileSync(constitutionPath, 'utf8');
      expect(newContent).toContain('# Modified');
    });
  });

  describe('loadConstitution()', () => {
    it('should load constitution from .gherkin-ai/constitution.yaml', () => {
      generateConstitution();
      
      const constitution = loadConstitution();
      expect(constitution).toBeDefined();
      expect(constitution!.architecture.style).toBeDefined();
      expect(constitution!.security.dataClassification).toBe('RESTRICTED');
    });

    it('should return null if no constitution exists', () => {
      // Don't generate anything
      const constitution = loadConstitution();
      expect(constitution).toBeNull();
    });

    it('should fall back to legacy .ghe/ directory', () => {
      const legacyDir = path.join(testDir, '.ghe');
      fs.mkdirSync(legacyDir);
      
      const legacyConfig = {
        architecture: { style: 'legacy-style' },
        security: { dataClassification: 'PUBLIC' },
        stack: { backend: 'legacy-node' }
      };
      
      fs.writeFileSync(path.join(legacyDir, 'constitution.yaml'), yaml.stringify(legacyConfig));
      
      const constitution = loadConstitution();
      expect(constitution).toBeDefined();
      expect(constitution!.architecture.style).toBe('legacy-style');
    });

    it('should handle malformed yaml gracefully', () => {
      const dir = getConstitutionDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'constitution.yaml'), 'invalid: yaml: :');
      
      const constitution = loadConstitution();
      expect(constitution).toBeNull();
    });
  });

  describe('getAgentPermissions()', () => {
    it('should return defined permissions for known roles', () => {
      generateConstitution();
      const constitution = loadConstitution();
      
      const perms = getAgentPermissions('domain', constitution);
      expect(perms.read).toBeInstanceOf(Array);
      expect(perms.write).toBeInstanceOf(Array);
      expect(perms.write).toContain('src/domain/**');
    });

    it('should return default full permissions for unknown roles', () => {
      generateConstitution();
      const constitution = loadConstitution();
      
      const perms = getAgentPermissions('unknown-role', constitution);
      expect(perms.read).toContain('**');
      expect(perms.write).toContain('**');
    });

    it('should return default permissions if constitution has no policies', () => {
      const emptyConstitution = {
        architecture: { style: 'test', required: [], forbidden: [] },
        security: { dataClassification: 'PUBLIC' as const, authProvider: '', secretsPolicy: '' },
        stack: { backend: '', frontend: '', database: '', testing: '' }
      };
      
      const perms = getAgentPermissions('domain', emptyConstitution);
      expect(perms.read).toContain('**');
    });
  });

  describe('getConstraintsByLevel()', () => {
    it('should filter constraints by the specified level', () => {
      generateConstitution();
      const constitution = loadConstitution();
      
      const mustConstraints = getConstraintsByLevel(constitution, 'must');
      expect(mustConstraints.length).toBeGreaterThan(0);
      expect(mustConstraints[0].description).toContain('authentication');
      
      const mustNotConstraints = getConstraintsByLevel(constitution, 'must-not');
      expect(mustNotConstraints.length).toBeGreaterThan(0);
    });

    it('should return empty array if no constraints exist', () => {
      const constitution = loadConstitution(); // null before generate
      const constraints = getConstraintsByLevel(constitution, 'must');
      expect(constraints).toEqual([]);
    });
  });

  describe('isLLMProviderAllowed()', () => {
    it('should deny forbidden providers', () => {
      generateConstitution();
      const constitution = loadConstitution();
      
      expect(isLLMProviderAllowed('public-free-models', constitution)).toBe(false);
    });

    it('should allow explicitly allowed providers', () => {
      generateConstitution();
      const constitution = loadConstitution();
      
      expect(isLLMProviderAllowed('openai', constitution)).toBe(true);
      expect(isLLMProviderAllowed('anthropic', constitution)).toBe(true);
    });

    it('should deny providers not in allowed list if allowed list exists', () => {
      generateConstitution();
      const constitution = loadConstitution();
      
      // Even though not in forbidden list, it's not in allowed list
      expect(isLLMProviderAllowed('unknown-provider', constitution)).toBe(false);
    });

    it('should allow any provider if no restrictions defined', () => {
      const emptyConstitution = {
        architecture: { style: 'test', required: [], forbidden: [] },
        security: { dataClassification: 'PUBLIC' as const, authProvider: '', secretsPolicy: '' },
        stack: { backend: '', frontend: '', database: '', testing: '' }
      };
      
      expect(isLLMProviderAllowed('any-provider', emptyConstitution)).toBe(true);
    });
    
    it('should allow any provider if constitution is null', () => {
      expect(isLLMProviderAllowed('openai', null)).toBe(true);
    });
  });
});
