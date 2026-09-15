import { describe, it, expect } from 'vitest';
import { PaymentProfile } from '../../src/core/profiles/payment-profile';

describe('PaymentProfile', () => {
  it('should define the correct payment domain profile', () => {
    const profile = new PaymentProfile();
    expect(profile.id).toBe('payments');
    expect(profile.name).toBe('Payment Platform Profile');
  });

  it('should expose common events and commands', () => {
    const profile = new PaymentProfile();
    
    // Commands
    expect(profile.commonCommands).toBeDefined();
    expect(profile.commonCommands.some(c => c.name === 'InitiatePayment')).toBe(true);
    expect(profile.commonCommands.some(c => c.name === 'AuthorizePayment')).toBe(true);

    // Events
    expect(profile.commonEvents).toBeDefined();
    expect(profile.commonEvents.some(e => e.name === 'PaymentInitiated')).toBe(true);
    expect(profile.commonEvents.some(e => e.name === 'PaymentCompleted')).toBe(true);
  });

  it('should define retry policies with DLQ', () => {
    const profile = new PaymentProfile();
    expect(profile.retryPolicies).toBeDefined();
    if (profile.retryPolicies) {
      expect(profile.retryPolicies['Authorization'].maxRetries).toBe(3);
      expect(profile.retryPolicies['Authorization'].dlq).toBe(true);
      expect(profile.retryPolicies['Authorization'].compensation).toBe('CancelAuthorization');
    }
  });

  it('should return standard rules', () => {
    const profile = new PaymentProfile();
    const rules = profile.getStandardRules();
    expect(rules).toContain('pci-dss-compliance');
    expect(rules).toContain('transactional-outbox-mandatory');
    expect(rules).toContain('saga-orchestration-mandatory');
  });
});
