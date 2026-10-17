import type { IndustryProfile } from './types';
import { glossaryRule, requireCompanion, requireTag, singleTagValue } from './lint-helpers';

const GLOSSARY = [
  { term: 'Debtor', avoid: ['payer', 'sender', 'ordenante'], definition: 'ISO 20022 party whose account is debited.' },
  { term: 'Creditor', avoid: ['payee', 'receiver', 'beneficiario'], definition: 'ISO 20022 party whose account is credited.' },
  { term: 'Customer Agreement', avoid: ['contract', 'contrato'], definition: 'BIAN business object binding a customer to a product.' }
];

export const banking: IndustryProfile = {
  id: 'banking',
  label: 'Banking & Financial Services',
  summary: 'Service-domain decomposition (BIAN Service Landscape) with ISO 20022 messages and data.',
  aliases: ['bank', 'banca', 'finance', 'financial-services', 'fintech', 'payments', 'payment', 'payment-platform'],
  standards: [
    { id: 'BIAN', name: 'BIAN Service Landscape', version: '12.0', url: 'https://bian.org/servicelandscape/', scope: 'Bounded contexts: one microservice and one API per Service Domain.' },
    { id: 'ISO20022', name: 'ISO 20022 Financial Services Messaging', url: 'https://www.iso20022.org/', scope: 'Canonical data dictionary and payment / reporting messages (pacs, pain, camt).' }
  ],
  canonicalModel: 'BIAN Service Domains (control records, service operations) + ISO 20022 Business Model',
  glossary: GLOSSARY,
  recommendedArchitectures: ['hexagonal', 'microservices', 'cqrs', 'event-driven'],
  recommendedPatterns: ['transactional-outbox', 'saga', 'idempotency-key', 'inner-vs-outer-api', 'audit-trail'],
  compliance: ['PCI DSS (card data)', 'SOX (financial reporting controls)', 'PSD2 / Open Banking (strong customer authentication)', 'AML / KYC'],
  tagNamespaces: ['bian', 'iso20022', 'capability'],
  approvalPaths: ['**/payments/**', '**/ledger/**', '**/*settlement*'],
  guidance: {
    compact: 'Banking (BIAN + ISO 20022): one Service Domain per service/API (@bian:<ServiceDomain>); name data with ISO 20022 terms (Debtor, Creditor, Amount+Currency); every monetary command is idempotent and goes through the outbox; never log PAN or credentials.',
    rules: [
      'Map each feature to exactly one BIAN Service Domain (@bian:<ServiceDomain>); an internal API exposes operations of that single domain only.',
      'Use BIAN service operations for commands (Initiate, Update, Execute, Request, Retrieve, Control, Exchange, Notify) and the domain control record as the aggregate.',
      'Model payment data with ISO 20022 terms and types: Debtor/Creditor, amounts as decimal + ISO 4217 currency, never floating point.',
      'Monetary commands require an Idempotency-Key and must emit their events through the transactional outbox.',
      'Separate Inner APIs (single service domain, canonical model) from Outer APIs (channel orchestration).',
      'Never persist or log full card numbers (PAN), CVV or credentials; mask account identifiers in logs.'
    ]
  },
  lintRules: [
    requireTag({
      id: 'GHK101', name: 'BIAN service domain declared', severity: 'warning', ns: 'bian',
      format: /^[A-Z][A-Za-z0-9]+$/, example: '@bian:PaymentExecution',
      why: 'BIAN service domains define the bounded context of the service.'
    }),
    singleTagValue({
      id: 'GHK102', name: 'One BIAN service domain per feature', severity: 'error', ns: 'bian',
      why: 'An internal API must expose functions of a single BIAN service domain (1:1).'
    }),
    requireCompanion({
      id: 'GHK103', name: 'Monetary commands are idempotent', severity: 'warning', scope: 'feature',
      when: /\b(pay|pays|paid|payment|transfer|withdraw|deposit|charge|refund|debit|credit|pago|paga|transferencia|retiro|dep[oó]sito|reembolso|abono|cargo)\b/i,
      require: /idempot|duplicate|same request|twice|replay|duplicad|mism[ao] (solicitud|petici[oó]n)|dos veces/i,
      message: 'Feature moves money but no scenario covers a duplicated request.',
      suggestion: 'Add a scenario where the same request (same Idempotency-Key) is sent twice and only one movement happens.'
    }),
    glossaryRule({ id: 'GHK104', name: 'ISO 20022 / BIAN vocabulary', severity: 'info', entries: GLOSSARY })
  ]
};
