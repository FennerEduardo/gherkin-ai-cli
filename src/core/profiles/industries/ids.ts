/* ==========================================================================
   gherkin-ai-cli - Industry profile ids (no imports: used by the config schema)
   ========================================================================== */

export const INDUSTRY_IDS = [
  'generic', 'banking', 'telecom', 'manufacturing', 'health',
  'supply-chain', 'insurance', 'aviation', 'automotive', 'education'
] as const;

export type IndustryId = typeof INDUSTRY_IDS[number];
