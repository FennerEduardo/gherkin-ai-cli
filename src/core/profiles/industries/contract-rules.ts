/* ==========================================================================
   gherkin-ai-cli - Industry rules over the contracts (OpenAPI)

   The lint rules of a profile check the specification. These check what the
   service exposes: the generated contracts, or the repository's own OpenAPI
   document. They run in `ghk validate` (an error fails it, exit 4) and in
   `ghk converge` (Architecture Compliance).

   Like the lint rules, they are engineering checks derived from a standard,
   not a certification against it.
   ========================================================================== */

export interface ContractDiagnostic {
  ruleId: string;
  severity: 'error' | 'warning';
  /** JSON-pointer-like location: #/components/schemas/Payment/properties/amount, or "POST /payments". */
  location: string;
  message: string;
  suggestion: string;
}

export interface ContractRule {
  id: string;
  name: string;
  severity: 'error' | 'warning';
  check(openapi: OpenApiDocument): ContractDiagnostic[];
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, any>>;
  components?: { schemas?: Record<string, any>; securitySchemes?: Record<string, any> };
  security?: unknown[];
}

interface PropertySite { location: string; name: string; schema: any; owner: any }

const HTTP_METHODS = new Set(['get', 'put', 'post', 'patch', 'delete']);

/** Every object property of the document's schemas (components and inline), with where it is. */
export function schemaProperties(doc: OpenApiDocument): PropertySite[] {
  const sites: PropertySite[] = [];
  const seen = new Set<any>();
  const walk = (schema: any, location: string) => {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return;
    seen.add(schema);
    for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
      sites.push({ location: `${location}/properties/${name}`, name, schema: prop, owner: schema });
      walk(prop, `${location}/properties/${name}`);
    }
    if (schema.items) walk(schema.items, `${location}/items`);
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) (schema[key] ?? []).forEach((s: any, i: number) => walk(s, `${location}/${key}/${i}`));
  };
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) walk(schema, `#/components/schemas/${name}`);
  for (const [route, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(ops ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      for (const [type, media] of Object.entries<any>(op?.requestBody?.content ?? {})) walk(media?.schema, `${method.toUpperCase()} ${route} request ${type}`);
      for (const [code, res] of Object.entries<any>(op?.responses ?? {})) {
        for (const [type, media] of Object.entries<any>(res?.content ?? {})) walk(media?.schema, `${method.toUpperCase()} ${route} ${code} ${type}`);
      }
    }
  }
  return sites;
}

const diag = (rule: Pick<ContractRule, 'id' | 'severity'>, location: string, message: string, suggestion: string): ContractDiagnostic =>
  ({ ruleId: rule.id, severity: rule.severity, location, message, suggestion });

const isNumber = (s: any) => s?.type === 'number' || (Array.isArray(s?.type) && s.type.includes('number'));

// ---------------------------------------------------------------------------
// Banking: ISO 20022 data types, PCI DSS
// ---------------------------------------------------------------------------

const MONEY = /^(amount|amt|instdamt|intrbksttlmamt|balance|price|fee|charge|total|value)$|amount$|Amt$/i;

export const bankingContractRules: ContractRule[] = [
  {
    id: 'GHK151', name: 'Amounts are decimals, never floating point (ISO 20022 ActiveCurrencyAndAmount)', severity: 'error',
    check(doc) {
      return schemaProperties(doc)
        .filter(p => MONEY.test(p.name) && isNumber(p.schema) && (p.schema.format === 'float' || p.schema.format === 'double'))
        .map(p => diag(this, p.location, `"${p.name}" is a ${p.schema.format}: binary floating point cannot represent money exactly.`,
          'Use a decimal string ({"type":"string","pattern":"^-?\\\\d{1,18}(\\\\.\\\\d{1,5})?$"}) or {"type":"number","multipleOf":0.01}.'));
    }
  },
  {
    id: 'GHK152', name: 'Every amount has an ISO 4217 currency', severity: 'warning',
    check(doc) {
      return schemaProperties(doc)
        .filter(p => MONEY.test(p.name) && (isNumber(p.schema) || p.schema?.type === 'string'))
        .filter(p => !Object.keys(p.owner.properties ?? {}).some(k => /^(currency|ccy|currencycode)$/i.test(k)))
        .map(p => diag(this, p.location, `"${p.name}" has no currency next to it.`,
          'Add "currency": {"type":"string","pattern":"^[A-Z]{3}$"} (ISO 4217) to the same object.'));
    }
  },
  {
    id: 'GHK153', name: 'IBAN and BIC carry their ISO formats', severity: 'warning',
    check(doc) {
      return schemaProperties(doc)
        .filter(p => /^(iban|bic|bicfi|anybic)$/i.test(p.name) && p.schema?.type === 'string' && !p.schema.pattern && !p.schema.format)
        .map(p => diag(this, p.location, `"${p.name}" accepts any string.`,
          /^iban$/i.test(p.name) ? 'Add "pattern": "^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$" (ISO 13616).' : 'Add "pattern": "^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$" (ISO 9362).'));
    }
  },
  {
    id: 'GHK154', name: 'No card data in contracts (PCI DSS)', severity: 'error',
    check(doc) {
      return schemaProperties(doc)
        .filter(p => /^(pan|cardnumber|card_number|primaryaccountnumber|cvv|cvc|cvv2|securitycode)$/i.test(p.name))
        .map(p => diag(this, p.location, `"${p.name}" exposes card data.`, 'Exchange a token from the card vault instead of the PAN or security code.'));
    }
  }
];

// ---------------------------------------------------------------------------
// Health: HL7 FHIR R5, HIPAA
// ---------------------------------------------------------------------------

const FHIR_RESOURCES = new Set(['Patient', 'Practitioner', 'PractitionerRole', 'Organization', 'Encounter', 'Observation', 'Condition', 'Procedure',
  'MedicationRequest', 'MedicationStatement', 'AllergyIntolerance', 'Immunization', 'DiagnosticReport', 'Appointment', 'CarePlan', 'Consent', 'Coverage', 'Claim']);
const PHI = /^(ssn|socialsecuritynumber|birthdate|dateofbirth|dob|mrn|medicalrecordnumber|diagnosis|diagnoses|condition|conditions|medication|medications|allergies|insurancenumber|healthcardnumber)$/i;

export const healthContractRules: ContractRule[] = [
  {
    id: 'GHK451', name: 'FHIR resources declare their resourceType', severity: 'warning',
    check(doc) {
      return Object.entries(doc.components?.schemas ?? {})
        .filter(([name, schema]) => FHIR_RESOURCES.has(name) && !(schema as any)?.properties?.resourceType)
        .map(([name]) => diag(this, `#/components/schemas/${name}`, `Schema "${name}" has the name of a FHIR resource but no resourceType.`,
          `Add "resourceType": {"type":"string","const":"${name}"} (or rename the schema if it is not the FHIR resource).`));
    }
  },
  {
    id: 'GHK452', name: 'Operations that carry PHI require authentication (HIPAA)', severity: 'error',
    check(doc) {
      const rootSecured = Array.isArray(doc.security) && doc.security.length > 0;
      const out: ContractDiagnostic[] = [];
      for (const [route, ops] of Object.entries(doc.paths ?? {})) {
        for (const [method, op] of Object.entries<any>(ops ?? {})) {
          if (!HTTP_METHODS.has(method)) continue;
          const secured = Array.isArray(op?.security) ? op.security.length > 0 : rootSecured;
          if (secured) continue;
          const phi = schemaProperties({ paths: { [route]: { [method]: op } }, components: doc.components }).filter(p => PHI.test(p.name) && !p.location.startsWith('#/components'));
          if (phi.length) out.push(diag(this, `${method.toUpperCase()} ${route}`, `Carries PHI (${[...new Set(phi.map(p => p.name))].join(', ')}) without a security requirement.`,
            'Declare "security" on the operation (or at the root) with the API\'s OAuth2 / bearer scheme.'));
        }
      }
      return out;
    }
  }
];

// ---------------------------------------------------------------------------
// Telecom: TM Forum Open APIs
// ---------------------------------------------------------------------------

const TMF_ENTITIES = new Set(['ProductOffering', 'ProductSpecification', 'ProductOrder', 'Product', 'ServiceOrder', 'Service', 'ResourceOrder', 'Resource',
  'Customer', 'Party', 'Individual', 'Organization', 'TroubleTicket', 'Agreement', 'BillingAccount']);

export const telecomContractRules: ContractRule[] = [
  {
    id: 'GHK251', name: 'TM Forum entities carry id, href and @type', severity: 'warning',
    check(doc) {
      return Object.entries(doc.components?.schemas ?? {})
        .filter(([name]) => TMF_ENTITIES.has(name))
        .flatMap(([name, schema]) => {
          const missing = ['id', 'href', '@type'].filter(k => !(schema as any)?.properties?.[k]);
          return missing.length ? [diag(this, `#/components/schemas/${name}`, `TM Forum entity "${name}" lacks ${missing.join(', ')}.`,
            'TMF Open API entities expose id, href and the polymorphic @type (TMF630 REST design guidelines).')] : [];
        });
    }
  }
];

export const CONTRACT_RULES_BY_INDUSTRY: Record<string, ContractRule[]> = {
  banking: bankingContractRules,
  health: healthContractRules,
  telecom: telecomContractRules
};

/** Runs the contract rules of an industry over an OpenAPI document. */
export function checkContracts(industry: string | undefined, openapi: OpenApiDocument | undefined, disabledRules: string[] = []): ContractDiagnostic[] {
  if (!industry || !openapi) return [];
  return (CONTRACT_RULES_BY_INDUSTRY[industry] ?? []).filter(r => !disabledRules.includes(r.id)).flatMap(r => r.check(openapi));
}
