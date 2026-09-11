/* ==========================================================================
   gherkin-ai-cli - Domain Profile Registry & Resolver
   ========================================================================== */

import { DomainProfile } from './base-profile';
import { PaymentProfile } from './payment-profile';

const profilesRegistry: Map<string, DomainProfile> = new Map();

// Registrar perfiles estándar
const paymentProfile = new PaymentProfile();
profilesRegistry.set('payments', paymentProfile);
profilesRegistry.set('payment', paymentProfile);
profilesRegistry.set('fintech', paymentProfile);
profilesRegistry.set('payment-platform', paymentProfile);

/**
 * Resuelve el perfil de dominio correspondiente según la configuración o nombre provisto.
 */
export function resolveDomainProfile(profileName?: string): DomainProfile | null {
  if (!profileName) return null;
  const key = profileName.toLowerCase().trim();
  return profilesRegistry.get(key) || null;
}

/**
 * Devuelve todos los nombres de perfiles de dominio registrados.
 */
export function getRegisteredProfileNames(): string[] {
  return Array.from(new Set(Array.from(profilesRegistry.keys())));
}
