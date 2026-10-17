import type { IndustryProfile } from './types';
import { forbidPattern, requireCompanion, requireTag } from './lint-helpers';

export const aviation: IndustryProfile = {
  id: 'aviation',
  label: 'Aviation & Travel Distribution',
  summary: 'IATA Modern Airline Retailing: NDC offers and ONE Order as the single customer order record, replacing PNR, e-ticket and EMD.',
  aliases: ['airline', 'aerolinea', 'aviacion', 'travel', 'iata', 'ndc'],
  standards: [
    { id: 'NDC', name: 'IATA New Distribution Capability', url: 'https://www.iata.org/en/programs/airline-distribution/retailing/ndc/', scope: 'Offer and order messages (AirShopping, OfferPrice, OrderCreate, OrderChange).' },
    { id: 'ONE-Order', name: 'IATA ONE Order', url: 'https://www.iata.org/en/programs/airline-distribution/retailing/one-order/', scope: 'Single order record with order items, services and delivery status.' }
  ],
  canonicalModel: 'IATA Offer / Order (Order, OrderItem, Service, ServiceDelivery)',
  glossary: [
    { term: 'Order', avoid: ['pnr', 'booking record', 'reserva'], definition: 'ONE Order record of everything the customer bought.' },
    { term: 'Service Delivery', avoid: ['ticket coupon'], definition: 'ONE Order status of delivering one service (e.g. a flight segment).' }
  ],
  recommendedArchitectures: ['microservices', 'event-driven', 'cqrs'],
  recommendedPatterns: ['offer-order-lifecycle', 'saga', 'transactional-outbox', 'idempotency-key'],
  compliance: ['PCI DSS (payments)', 'Passenger data rules (API/PNR data, GDPR)', 'Passenger rights regulations (e.g. EU 261/2004)'],
  tagNamespaces: ['iata', 'capability'],
  approvalPaths: ['**/payments/**', '**/revenue-accounting/**'],
  guidance: {
    compact: 'Aviation (IATA NDC + ONE Order): orders are created from a priced Offer (@iata:OrderCreate); the Order with its OrderItems is the single record (no PNR / e-ticket / EMD as aggregates); every change and service delivery emits an event for revenue accounting and disruption handling.',
    rules: [
      'Declare the NDC / ONE Order capability each feature implements (@iata:<Message or capability>, e.g. @iata:OrderCreate).',
      'An Order is always created from a priced Offer with an expiry; expired offers are rejected.',
      'The Order and its OrderItems are the single customer record: do not model PNR, e-ticket or EMD as aggregates.',
      'Every order change and service delivery status emits an event (revenue accounting, disruption management).',
      'Order changes (reshop, cancel, refund) are idempotent operations on the existing order, never a new booking.'
    ]
  },
  lintRules: [
    requireTag({
      id: 'GHK701', name: 'IATA capability declared', severity: 'warning', ns: 'iata',
      format: /^[A-Z][A-Za-z0-9]+$/, example: '@iata:OrderCreate',
      why: 'NDC / ONE Order messages define the service contract.'
    }),
    forbidPattern({
      id: 'GHK702', name: 'ONE Order vocabulary (no PNR / ticket aggregates)', severity: 'warning',
      pattern: /\b(pnr|e-?tickets?|emds?|booking record|localizador)\b/i,
      message: 'Step uses legacy PNR / ticket vocabulary.',
      suggestion: 'Model it as an Order with OrderItems and service delivery statuses (IATA ONE Order).'
    }),
    requireCompanion({
      id: 'GHK703', name: 'Orders come from an offer', severity: 'warning', scope: 'feature',
      when: /\b(creates? an order|order is created|places? an order|crea (una|la) orden|se crea la orden)\b/i,
      require: /\boffers?\b|\bofertas?\b/i,
      message: 'Feature creates orders without referencing the offer they come from.',
      suggestion: 'State the priced offer (and its expiry) the order is created from.'
    })
  ]
};
