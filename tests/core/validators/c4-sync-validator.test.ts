import { describe, it, expect } from 'vitest';
import { validateC4Sync } from '../../../src/core/validators/c4-sync-validator';

describe('validateC4Sync', () => {
  it('should warn if no C4 diagram is found', () => {
    const result = validateC4Sync({
      rules: [],
      files: [
        { path: 'src/code.cs', content: 'public class Repository {}' }
      ]
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('No C4 diagram found');
  });

  it('should fail if code has DB but C4 does not have ContainerDb', () => {
    const result = validateC4Sync({
      rules: [],
      files: [
        { path: 'docs/arch.md', content: 'C4Context\nContainer(api, "API")' },
        { path: 'src/Repository.cs', content: 'public class DbContext {}' }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('C4 Inconsistency');
  });

  it('should pass if code has DB and C4 has ContainerDb', () => {
    const result = validateC4Sync({
      rules: [],
      files: [
        { path: 'docs/arch.md', content: 'C4Context\nContainerDb(db, "DB")' },
        { path: 'src/Repository.cs', content: 'public class DbContext {}' }
      ]
    });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});
