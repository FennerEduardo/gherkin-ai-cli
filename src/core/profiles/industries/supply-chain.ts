import type { IndustryProfile } from './types';
import { glossaryRule, requireTag } from './lint-helpers';

const GLOSSARY = [
  { term: 'Supplier', avoid: ['vendor', 'proveedor externo'], definition: 'Party that provides materials or services (Source).' },
  { term: 'Inventory', avoid: ['stock'], definition: 'Materials held at a location, governed as master data.' },
  { term: 'Shipment', avoid: ['dispatch'], definition: 'Goods moved to a customer or location (Fulfill).' }
];

export const supplyChain: IndustryProfile = {
  id: 'supply-chain',
  label: 'Supply Chain & Logistics',
  summary: 'ASCM SCOR Digital Standard: processes (Orchestrate, Plan, Order, Source, Transform, Fulfill, Return) measured by SCOR metrics.',
  aliases: ['logistics', 'logistica', 'scm', 'scor', 'cadena-de-suministro'],
  standards: [
    { id: 'SCOR-DS', name: 'ASCM SCOR Digital Standard', url: 'https://www.ascm.org/corporate-solutions/standards-tools/scor-ds/', scope: 'Process codes and performance metrics (reliability, responsiveness, agility, cost, assets).' },
    { id: 'GS1', name: 'GS1 identification standards', url: 'https://www.gs1.org/standards', scope: 'Identifiers for items, locations and shipments (GTIN, GLN, SSCC).' }
  ],
  canonicalModel: 'SCOR-DS process hierarchy + GS1 identifiers for master data',
  glossary: GLOSSARY,
  recommendedArchitectures: ['event-driven', 'microservices', 'cqrs'],
  recommendedPatterns: ['saga', 'transactional-outbox', 'master-data-management', 'event-sourcing-for-traceability'],
  compliance: ['Product traceability and recall regulations', 'Customs and trade compliance'],
  tagNamespaces: ['scor', 'scor-metric', 'capability'],
  approvalPaths: ['**/master-data/**'],
  guidance: {
    compact: 'Supply chain (SCOR-DS): anchor each feature to a SCOR-DS process (@scor:<code>) and the metric it moves (@scor-metric:RL.1.1); identify items, locations and shipments with GS1 keys; master data is governed, never created ad hoc by transactions.',
    rules: [
      'Anchor every feature to the SCOR-DS process it implements (@scor:<code>, e.g. O for Order, F for Fulfill) and to the metric it improves (@scor-metric:<code>).',
      'Identify items, locations and logistic units with GS1 keys (GTIN, GLN, SSCC) instead of internal free-text ids.',
      'Item, supplier and location master data are governed by their own service; transactions reference them and never create them implicitly.',
      'Every state change of an order or shipment emits an event so the end-to-end flow is traceable.',
      'Expose the metric the feature moves (e.g. perfect order fulfillment) as an observable measure.'
    ]
  },
  lintRules: [
    requireTag({
      id: 'GHK501', name: 'SCOR-DS process declared', severity: 'warning', ns: 'scor',
      format: /^(OR|P|O|S|T|F|R)(\d+(\.\d+)*)?$/i, example: '@scor:O1',
      why: 'Each capability must be anchored to a SCOR-DS process.'
    }),
    requireTag({
      id: 'GHK502', name: 'SCOR-DS metric declared', severity: 'warning', ns: 'scor-metric',
      format: /^[A-Z]{2}\.\d+(\.\d+)*$/, example: '@scor-metric:RL.1.1',
      why: 'A use case that cannot name the SCOR metric it moves has no measurable outcome.'
    }),
    glossaryRule({ id: 'GHK503', name: 'Supply chain vocabulary', severity: 'info', entries: GLOSSARY })
  ]
};
