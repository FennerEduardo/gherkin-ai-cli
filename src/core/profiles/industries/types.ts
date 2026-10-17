/* ==========================================================================
   gherkin-ai-cli - Industry profile model

   An industry profile turns a reference standard (BIAN, TM Forum ODA, HL7
   FHIR, ...) into data the CLI and the LLM can use: canonical vocabulary,
   recommended architecture, compliance reminders, prompt guidance and
   deterministic lint rules over the Gherkin specification.

   Compliance entries are engineering guidance, not certification.
   ========================================================================== */

import { z } from 'zod';
import { ARCHITECTURES } from '../../config/schema';
import type { LintRule } from '../../specification-linter';
import { INDUSTRY_IDS } from './ids';

export const industryStandardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  /** Public reference for the standard (cited in the generated context). */
  url: z.string().url(),
  /** What the standard governs in the generated service. */
  scope: z.string().min(1)
});

export const glossaryEntrySchema = z.object({
  /** Canonical term the specification and code should use. */
  term: z.string().min(1),
  /** Synonyms the linter flags (lower case, matched as whole words). */
  avoid: z.array(z.string().min(1)).min(1),
  definition: z.string().min(1)
});

export const industryProfileSchema = z.object({
  id: z.enum(INDUSTRY_IDS),
  label: z.string().min(1),
  summary: z.string().min(1),
  /** Other names accepted by `industry.id` / `domainProfile` (e.g. "fintech"). */
  aliases: z.array(z.string()),
  standards: z.array(industryStandardSchema),
  /** The canonical information / capability model features are mapped to. */
  canonicalModel: z.string().min(1),
  glossary: z.array(glossaryEntrySchema),
  recommendedArchitectures: z.array(z.enum(ARCHITECTURES)).min(1),
  recommendedPatterns: z.array(z.string()).min(1),
  compliance: z.array(z.string()),
  /** Gherkin tag namespaces the profile reads (e.g. "bian" for @bian:PaymentExecution). */
  tagNamespaces: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)),
  /** Globs whose modification requires human approval (added to the agent firewall). */
  approvalPaths: z.array(z.string()),
  guidance: z.object({
    /** One paragraph for compact prompts (-C). */
    compact: z.string().min(1).max(500),
    /** Rules the LLM must follow, one per line. */
    rules: z.array(z.string().min(1)).min(3)
  })
});

export type IndustryStandard = z.infer<typeof industryStandardSchema>;
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;
export type IndustryProfileData = z.infer<typeof industryProfileSchema>;

export interface IndustryProfile extends IndustryProfileData {
  /** Deterministic rules added to `ghk lint` when the project declares this industry. */
  lintRules: LintRule[];
}
