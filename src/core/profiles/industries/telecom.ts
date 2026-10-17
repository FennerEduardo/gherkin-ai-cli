import type { IndustryProfile } from './types';
import { forbidPattern, glossaryRule, requireTag } from './lint-helpers';

const GLOSSARY = [
  { term: 'Product Offering', avoid: ['plan', 'tariff', 'tarifa'], definition: 'SID entity: what is sold from the catalog (TMF620).' },
  { term: 'Customer', avoid: ['subscriber', 'suscriptor', 'abonado'], definition: 'SID party role that buys products (TMF629).' },
  { term: 'Product Order', avoid: ['activation request', 'solicitud de activación'], definition: 'SID entity that requests products for a customer (TMF622).' }
];

export const telecom: IndustryProfile = {
  id: 'telecom',
  label: 'Telecommunications',
  summary: 'TM Forum Open Digital Architecture: ODA components exposing TM Forum Open APIs over the SID information model.',
  aliases: ['telco', 'telecommunications', 'telecomunicaciones', 'tmforum', 'oda'],
  standards: [
    { id: 'ODA', name: 'TM Forum Open Digital Architecture', url: 'https://www.tmforum.org/oda/', scope: 'Component boundaries and the ODA Canvas runtime (Kubernetes operators).' },
    { id: 'TMF-OpenAPI', name: 'TM Forum Open APIs', url: 'https://www.tmforum.org/oda/open-apis/', scope: 'REST contracts per component (e.g. TMF620 catalog, TMF622 ordering, TMF641 service ordering).' },
    { id: 'SID', name: 'TM Forum Information Framework (SID)', url: 'https://www.tmforum.org/oda/information-systems/information-framework-sid/', scope: 'Canonical entities: Party, Customer, Product, Service, Resource.' }
  ],
  canonicalModel: 'TM Forum SID entities exposed through TMF Open APIs',
  glossary: GLOSSARY,
  recommendedArchitectures: ['microservices', 'event-driven', 'hexagonal'],
  recommendedPatterns: ['tmf-open-api-contract', 'event-notification-hub', 'saga', 'transactional-outbox'],
  compliance: ['GDPR / local data protection (customer data)', 'Lawful interception and data retention rules', 'Number portability regulations'],
  tagNamespaces: ['tmf', 'oda', 'capability'],
  approvalPaths: ['**/billing/**', '**/charging/**'],
  guidance: {
    compact: 'Telecom (TM Forum ODA): each service is one ODA component exposing a TMF Open API (@tmf:TMF622); entities use SID names (Customer, ProductOffering, ProductOrder); publish state changes as TMF events; scenarios stay implementation-agnostic.',
    rules: [
      'Declare the TMF Open API each feature implements (@tmf:TMFnnn) and keep resource names and paths aligned with that API.',
      'Use SID entity names (Party, Customer, ProductOffering, Product, Service, Resource) for aggregates and payloads.',
      'Publish resource state changes as TMF notification events (e.g. ProductOrderStateChangeEvent) through the outbox.',
      'Write scenarios at the business level (TAC-353 BDD style): no UI clicks, screens or technical details in steps.',
      'Package each service as an ODA component: health probes, exposed APIs and dependent APIs declared in its manifest.'
    ]
  },
  lintRules: [
    requireTag({
      id: 'GHK201', name: 'TM Forum Open API declared', severity: 'warning', ns: 'tmf',
      format: /^TMF\d{3}$/, example: '@tmf:TMF622',
      why: 'ODA components expose TM Forum Open APIs.'
    }),
    glossaryRule({ id: 'GHK202', name: 'SID vocabulary', severity: 'info', entries: GLOSSARY }),
    forbidPattern({
      id: 'GHK203', name: 'Implementation-agnostic scenarios (TAC-353)', severity: 'warning',
      pattern: /\b(clicks?|button|screen|page|dropdown|textbox|hace clic|bot[oó]n|pantalla|p[aá]gina)\b/i,
      message: 'Step describes the user interface instead of business behaviour.',
      suggestion: 'Describe what the customer achieves, not how the UI is operated (TM Forum TAC-353 BDD style).'
    })
  ]
};
