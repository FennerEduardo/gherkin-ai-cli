/* ==========================================================================
   gherkin-ai-cli - Language-neutral facts in a method body (`ghk reverse`)

   What a handler or service body says the same way in C#, Python and Go:
   the status values it writes and the events it publishes. Read from the
   body text, with the line of each match; the structural parts (routes,
   conditions, calls) stay in each language adapter.
   ========================================================================== */

import { makeEvidence, type SourceEvidence } from '../../evidence';
import { eventName } from '../typescript/ts-body';

export interface TextScope {
  /** Body text and the 1-based line it starts on. */
  text: string;
  startLine: number;
  file: string;
  extractor: string;
  endpointId: string;
}

/** Event classes that carry the event name as data, or that are not domain events. */
const GENERIC_EVENT = /^(Domain|Integration|Outbox|Base|Abstract|Incoming|Outgoing|Application|Cloud|Message|Generic|Custom)?Event$|DomainEvent$|IntegrationEvent$/;

const lineOf = (s: TextScope, offset: number) => s.startLine + (s.text.slice(0, offset).match(/\n/g)?.length ?? 0);

function evidence(s: TextScope, kind: 'state-value' | 'domain-event', offset: number, description: string, metadata: Record<string, unknown>, symbol?: string): SourceEvidence {
  const line = lineOf(s, offset);
  return makeEvidence({ kind, extractor: s.extractor, confidence: 'strong', references: [s.endpointId], location: { file: s.file, startLine: line, endLine: line }, description, symbol, metadata });
}

/**
 * Status values written: `order.Status = OrderStatus.Cancelled` (C#), `order.status = OrderStatus.CANCELLED`,
 * `status=OrderStatus.PENDING` (Python), `o.Status = "CANCELLED"`, `&Order{Status: "PENDING"}` (Go),
 * `{ Status = OrderStatus.Pending }` (C# initializer), `"status": "X"` in a returned map.
 */
export function statesInText(s: TextScope): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  const seen = new Set<string>();
  const add = (value: string, offset: number, how: string) => {
    // Several patterns can match one assignment: one fact per value and line.
    const key = `${value}:${lineOf(s, offset)}`;
    if (seen.has(key)) return;
    if (/^[A-Za-z][\w-]{1,40}$/.test(value) && !/^(None|null|nil|true|false|True|False)$/.test(value)) { seen.add(key); out.push(evidence(s, 'state-value', offset, `status ${how} ${value}`, { field: 'status', value })); }
  };
  const patterns: [RegExp, string][] = [
    [/\.(?:status|state)\s*=\s*(?:[\w.]*(?:Status|State)\.)?["']?([A-Za-z][\w-]*)["']?/gi, 'set to'],
    [/\b(?:Status|State|status|state)\s*[:=]\s*(?:[\w.]*(?:Status|State)\.)([A-Za-z][\w-]*)/g, 'created with'],
    [/\b(?:Status|State)\s*:\s*"([A-Za-z][\w-]*)"/g, 'created with'],
    [/["'](?:status|state)["']\s*[:,]\s*["']([A-Za-z][\w-]*)["']/g, 'returned as']
  ];
  for (const [re, how] of patterns) for (const m of s.text.matchAll(re)) add(m[1], m.index!, how);
  return out;
}

/**
 * Events published: `new OrderPlacedEvent(…)` / `OrderPlacedEvent(…)`, a generic class named by its first
 * argument (`DomainEvent("OrderPlaced", …)`), or a name passed to a publisher (`bus.publish("OrderPlaced", …)`,
 * `s.bus.Publish("order.placed", …)`).
 */
export function eventsInText(s: TextScope): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  for (const m of s.text.matchAll(/\b(?:new\s+|&)?([A-Z]\w*Event)\s*(?:\{|\()\s*(?:["']([A-Z][A-Za-z0-9]+)["'])?/g)) {
    if (m[2]) out.push(evidence(s, 'domain-event', m.index!, `publishes ${m[2]}`, { event: m[2] }, m[1]));
    else if (!GENERIC_EVENT.test(m[1])) out.push(evidence(s, 'domain-event', m.index!, `publishes ${eventName(m[1])}`, { event: eventName(m[1]) }, m[1]));
  }
  for (const m of s.text.matchAll(/\b\w*(?:bus|publisher|emitter|producer|events?|broker|kafka|rabbit|nats|outbox)\w*\s*\.\s*(?:publish|Publish|emit|Emit|send|Send|produce|Produce|PublishAsync|SendAsync|dispatch)\w*\s*\(\s*(?:ctx\s*,\s*|context\s*,\s*)?["']([\w.:-]+)["']/gi)) {
    out.push(evidence(s, 'domain-event', m.index!, `publishes ${eventName(m[1])}`, { event: eventName(m[1]), channel: m[1] }, m[1]));
  }
  return out;
}

/** A concrete test URL (`/api/orders/o-1/cancel`) matches a route template (`/api/orders/{id}/cancel`). */
export function pathMatchesTemplate(template: string, concrete: string): boolean {
  const t = template.split('/').filter(Boolean);
  const c = concrete.split('/').filter(Boolean);
  return t.length === c.length && t.every((seg, i) => /^\{[^}]+\}$/.test(seg) || /^\{[^}]+\}$/.test(c[i]) || seg.toLowerCase() === c[i].toLowerCase());
}
