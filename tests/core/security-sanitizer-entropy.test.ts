import { describe, it, expect } from 'vitest';
import { detectPromptInjection, calculateShannonEntropy, isHighEntropySecret } from '../../src/core/security-sanitizer';

describe('Security Sanitizer & Entropy Scanner', () => {
  it('should detect AWS Access Key ID', () => {
    const result = detectPromptInjection('My key is AKIAIOSFODNN7EXAMPLE');
    expect(result.isSafe).toBe(false);
    expect(result.reason).toContain('hardcoded secret');
  });

  it('should detect RSA private key', () => {
    const result = detectPromptInjection('-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...');
    expect(result.isSafe).toBe(false);
  });

  it('should calculate Shannon entropy correctly', () => {
    expect(calculateShannonEntropy('aaaaa')).toBe(0);
    expect(calculateShannonEntropy('abcdefghijklmnopqrstuvwxyz0123456789')).toBeGreaterThan(4.5);
  });

  it('should identify high entropy tokens', () => {
    const token = '8f94a2b7e1c3d5f6a9b8c7d6e5f4a3b2c1d0e9f8a7b6';
    expect(isHighEntropySecret(token)).toBe(true);
  });
});
