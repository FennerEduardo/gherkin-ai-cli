import type { IndustryProfile } from './types';
import { glossaryRule, requireCompanion, requireTag } from './lint-helpers';

const GLOSSARY = [
  { term: 'Policy', avoid: ['contract', 'contrato'], definition: 'ACORD agreement providing coverage to a policyholder.' },
  { term: 'Claim', avoid: ['incident report', 'siniestro reportado'], definition: 'ACORD request for benefits under a policy.' },
  { term: 'Party', avoid: ['client', 'cliente'], definition: 'ACORD person or organization in a role (policyholder, insured, claimant).' }
];

export const insurance: IndustryProfile = {
  id: 'insurance',
  label: 'Insurance',
  summary: 'ACORD Reference Architecture: capability model, information model and data standards for policy, billing and claims.',
  aliases: ['insurtech', 'seguros', 'reinsurance', 'acord'],
  standards: [
    { id: 'ACORD', name: 'ACORD Reference Architecture', url: 'https://www.acord.org/standards-architecture/reference-architecture', scope: 'Capability model (bounded contexts) and information model (Party, Policy, Claim).' },
    { id: 'ACORD-Data', name: 'ACORD data standards (P&C, Life)', url: 'https://www.acord.org/standards-architecture/acord-data-standards', scope: 'Message formats for policy, billing and claims exchange.' }
  ],
  canonicalModel: 'ACORD Capability Model + ACORD Information Model',
  glossary: GLOSSARY,
  recommendedArchitectures: ['hexagonal', 'microservices', 'event-driven'],
  recommendedPatterns: ['saga', 'transactional-outbox', 'rules-engine-for-underwriting', 'audit-trail'],
  compliance: ['Solvency II / local solvency rules', 'IFRS 17 (insurance contracts reporting)', 'Data protection for policyholder data'],
  tagNamespaces: ['acord', 'capability'],
  approvalPaths: ['**/underwriting/**', '**/claims/**', '**/rating/**'],
  guidance: {
    compact: 'Insurance (ACORD): map each feature to an ACORD capability (@acord:<Capability>); name entities with the ACORD information model (Party, Policy, Coverage, Claim); claims cover approval and denial paths; underwriting and rating rules are explicit, versioned and auditable.',
    rules: [
      'Map each feature to an ACORD capability (@acord:<Capability>, e.g. ClaimManagement) and keep one capability per service.',
      'Use ACORD information model names: Party (in a role), Policy, Coverage, Premium, Claim, Payment.',
      'Claims and underwriting decisions cover approval, denial and referral paths, each with an auditable reason.',
      'Rating and underwriting rules are explicit and versioned; a decision records the rule version that produced it.',
      'Policy changes are new versions with effective dates (endorsements), never in-place updates.'
    ]
  },
  lintRules: [
    requireTag({
      id: 'GHK601', name: 'ACORD capability declared', severity: 'warning', ns: 'acord',
      format: /^[A-Z][A-Za-z0-9]+$/, example: '@acord:ClaimManagement',
      why: 'ACORD capabilities define the bounded contexts of insurance services.'
    }),
    glossaryRule({ id: 'GHK602', name: 'ACORD vocabulary', severity: 'info', entries: GLOSSARY }),
    requireCompanion({
      id: 'GHK603', name: 'Claims cover the denial path', severity: 'warning', scope: 'feature',
      when: /\b(claims?|siniestros?|reclamaci[oó]n)\b/i,
      require: /\b(den(y|ied|ies|ial)|reject\w*|declin\w*|rechaza\w*|deneg\w*)\b/i,
      message: 'Claim feature has no denial / rejection scenario.',
      suggestion: 'Add a scenario where the claim is denied and the reason is recorded.'
    })
  ]
};
