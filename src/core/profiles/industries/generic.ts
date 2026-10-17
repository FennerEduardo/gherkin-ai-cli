import type { IndustryProfile } from './types';

export const generic: IndustryProfile = {
  id: 'generic',
  label: 'Generic (no industry standard)',
  summary: 'No reference standard: business-capability bounded contexts with the common gherkin-ai rules only.',
  aliases: ['none', 'general'],
  standards: [],
  canonicalModel: 'Business capability map of the organization',
  glossary: [],
  recommendedArchitectures: ['hexagonal', 'microservices'],
  recommendedPatterns: ['transactional-outbox', 'idempotency-key'],
  compliance: [],
  tagNamespaces: ['capability'],
  approvalPaths: [],
  guidance: {
    compact: 'Generic: one bounded context per business capability (@capability:L1/L2, at most L4); the ubiquitous language of the feature names aggregates, commands and events.',
    rules: [
      'Map each feature to one business capability (@capability:<L1>/<L2>[/<L3>[/<L4>]]); decomposition stops at L4.',
      'Use the ubiquitous language of the specification for aggregates, commands and events.',
      'A capability used by several areas is a shared service, never duplicated in each consumer.'
    ]
  },
  lintRules: []
};
