/* ==========================================================================
   gherkin-ai-cli - Domain Profile Registry & Resolver
   ========================================================================== */

import { DomainProfile } from './base-profile';
import { PaymentProfile } from './payment-profile';

const profilesRegistry: Map<string, DomainProfile> = new Map();

// Register standard profiles
const paymentProfile = new PaymentProfile();
profilesRegistry.set('payments', paymentProfile);
profilesRegistry.set('payment', paymentProfile);
profilesRegistry.set('fintech', paymentProfile);
profilesRegistry.set('payment-platform', paymentProfile);

/**
 * Resolves the corresponding domain profile based on the configuration or provided name.
 */
export function resolveDomainProfile(profileName?: string): DomainProfile | null {
  if (!profileName) return null;
  const key = profileName.toLowerCase().trim();
  return profilesRegistry.get(key) || null;
}

/**
 * Returns all registered domain profile names.
 */
export function getRegisteredProfileNames(): string[] {
  return Array.from(new Set(Array.from(profilesRegistry.keys())));
}
