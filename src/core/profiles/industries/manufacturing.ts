import type { IndustryProfile } from './types';
import { customRule, featureText, requireTag, tagValues } from './lint-helpers';

const ASSET = /\b(machine|asset|equipment|press|robot|m[aá]quina|activo|equipo)\b/i;
const TELEMETRY = /\b(sensor|telemetry|temperature|pressure|vibration|reading|tag value|telemetr[ií]a|temperatura|presi[oó]n|vibraci[oó]n|lectura)\b/i;
const TRANSACTION = /\b(work order|production order|batch|lot|order|orden de (trabajo|producci[oó]n)|lote|pedido)\b/i;

export const manufacturing: IndustryProfile = {
  id: 'manufacturing',
  label: 'Manufacturing & Energy (Industry 4.0)',
  summary: 'RAMI 4.0 layering, Asset Administration Shell digital twins and an ISA-95 Unified Namespace over MQTT Sparkplug B.',
  aliases: ['industry-4.0', 'industria-4.0', 'manufactura', 'energy', 'energia', 'iiot'],
  standards: [
    { id: 'RAMI4.0', name: 'Reference Architectural Model Industrie 4.0', url: 'https://www.plattform-i40.de/', scope: 'Layers (asset to business) and hierarchy levels of the system.' },
    { id: 'AAS', name: 'IDTA Asset Administration Shell', url: 'https://industrialdigitaltwin.org/', scope: 'Digital twin submodels per asset (nameplate, technical data, operational data).' },
    { id: 'ISA-95', name: 'ISA-95 Enterprise-Control System Integration', url: 'https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard', scope: 'Equipment hierarchy and ERP–MES transactions.' },
    { id: 'Sparkplug', name: 'Eclipse Sparkplug B (MQTT)', url: 'https://sparkplug.eclipse.org/', scope: 'Real-time state in the Unified Namespace.' }
  ],
  canonicalModel: 'ISA-95 equipment hierarchy (enterprise/site/area/line/cell) + AAS submodels',
  glossary: [
    { term: 'Work Order', avoid: ['job ticket'], definition: 'ISA-95 production request executed by MES.' },
    { term: 'Equipment', avoid: ['device thing'], definition: 'ISA-95 physical asset in the hierarchy.' }
  ],
  recommendedArchitectures: ['event-driven', 'microservices', 'hexagonal'],
  recommendedPatterns: ['unified-namespace', 'digital-twin', 'transactional-outbox', 'idempotent-consumer'],
  compliance: ['IEC 62443 (industrial cybersecurity)', 'Functional safety stays in the control layer (IEC 61508)'],
  tagNamespaces: ['isa95', 'aas', 'capability'],
  approvalPaths: ['**/plc/**', '**/scada/**', '**/control/**'],
  guidance: {
    compact: 'Manufacturing (RAMI 4.0 / AAS / ISA-95 UNS): address assets by their ISA-95 path (@isa95:enterprise/site/area/line); model asset data as AAS submodels; keep real-time telemetry (UNS, MQTT Sparkplug B) apart from ERP–MES transactions; never write to PLCs from the business service.',
    rules: [
      'Identify every asset and event source by its ISA-95 hierarchy path enterprise/site/area/line/cell (@isa95:<path>).',
      'Model asset information as Asset Administration Shell submodels (@aas:<Submodel>) instead of ad hoc fields.',
      'Real-time telemetry flows through the Unified Namespace (MQTT Sparkplug B topics); work orders, batches and material movements flow through typed ISA-95 transactions.',
      'Business services never command PLCs or SCADA directly; control actions go through the control layer with human approval.',
      'Events carry the asset path and a source timestamp; consumers are idempotent because telemetry is redelivered.'
    ]
  },
  lintRules: [
    requireTag({
      id: 'GHK301', name: 'ISA-95 hierarchy path declared', severity: 'warning', ns: 'isa95',
      format: /^[a-z0-9-]+(\/[a-z0-9-]+){2,4}$/i, example: '@isa95:acme/plant-a/assembly/line-1',
      why: 'The Unified Namespace addresses data by its ISA-95 path (enterprise/site/area[/line[/cell]]).'
    }),
    customRule({
      id: 'GHK302', name: 'Asset features reference an AAS submodel', severity: 'warning',
      check: (parsed, emit) => ASSET.test(featureText(parsed)) && tagValues(parsed, 'aas').length === 0
        ? [emit('Feature works with assets but declares no Asset Administration Shell submodel.', { suggestion: 'Tag the feature with the submodel it reads or writes, e.g. @aas:TechnicalData.' })]
        : []
    }),
    {
      id: 'GHK303', name: 'Telemetry separated from transactions', severity: 'warning',
      check: parsed => parsed.scenarios
        .filter(s => {
          const text = [s.name, ...s.steps.map(st => st.text)].join('\n');
          return TELEMETRY.test(text) && TRANSACTION.test(text);
        })
        .map(s => ({
          ruleId: 'GHK303', severity: 'warning' as const, scenario: s.name, line: s.line,
          message: 'Scenario mixes real-time telemetry with ERP–MES transactions.',
          suggestion: 'Split it: telemetry is published to the Unified Namespace; the work order / batch change is a separate ISA-95 transaction.'
        }))
    }
  ]
};
