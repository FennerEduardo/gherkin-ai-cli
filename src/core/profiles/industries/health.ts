import type { IndustryProfile } from './types';
import { forbidPattern, requireCompanion, requireTag } from './lint-helpers';

/** FHIR R4/R5 resources most services expose; other resources are accepted with a warning. */
export const FHIR_RESOURCES = [
  'Patient', 'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Encounter', 'EpisodeOfCare',
  'Observation', 'Condition', 'Procedure', 'AllergyIntolerance', 'DiagnosticReport', 'ImagingStudy', 'Specimen',
  'MedicationRequest', 'MedicationStatement', 'MedicationAdministration', 'MedicationDispense', 'Medication',
  'Immunization', 'CarePlan', 'CareTeam', 'Goal', 'ServiceRequest', 'Appointment', 'Schedule', 'Slot',
  'Consent', 'DocumentReference', 'Composition', 'Coverage', 'Claim', 'ClaimResponse', 'ExplanationOfBenefit',
  'Questionnaire', 'QuestionnaireResponse', 'Communication', 'Task', 'Device', 'Bundle', 'Provenance', 'AuditEvent'
];

export const health: IndustryProfile = {
  id: 'health',
  label: 'Healthcare',
  summary: 'Dual model: clinical data persisted as openEHR archetypes, exchanged through HL7 FHIR resources.',
  aliases: ['healthcare', 'salud', 'clinical', 'ehr', 'fhir', 'openehr'],
  standards: [
    { id: 'FHIR', name: 'HL7 FHIR', version: 'R4 / R5', url: 'https://hl7.org/fhir/', scope: 'Exchange API: resources, RESTful interactions, SMART on FHIR scopes.' },
    { id: 'openEHR', name: 'openEHR', url: 'https://www.openehr.org/', scope: 'Persistence: archetypes and templates for the clinical record.' }
  ],
  canonicalModel: 'HL7 FHIR resources at the API, openEHR archetypes in the clinical repository',
  glossary: [
    { term: 'Encounter', avoid: ['visit', 'consulta'], definition: 'FHIR interaction between a patient and providers.' },
    { term: 'Practitioner', avoid: ['doctor', 'médico'], definition: 'FHIR person directly involved in care (any discipline).' }
  ],
  recommendedArchitectures: ['hexagonal', 'microservices', 'event-driven'],
  recommendedPatterns: ['fhir-facade', 'consent-enforcement', 'audit-event', 'transactional-outbox'],
  compliance: ['HIPAA (US) / GDPR special-category data (EU) / local health data law', 'Consent and purpose-of-use enforcement', 'Audit of every PHI access (FHIR AuditEvent)'],
  tagNamespaces: ['fhir', 'openehr', 'capability'],
  approvalPaths: ['**/phi/**', '**/patients/**', '**/consent/**', '**/clinical/**'],
  guidance: {
    compact: 'Health (FHIR + openEHR): expose data as FHIR resources (@fhir:<Resource>); every PHI access checks consent/authorization and writes an AuditEvent; persist clinical content as openEHR archetypes; use synthetic data only, never real identifiers.',
    rules: [
      'Expose each capability through the FHIR resource it manages (@fhir:<Resource>), with standard RESTful interactions and status codes.',
      'Every read or write of protected health information (PHI) checks consent and the caller authorization (SMART on FHIR scopes) before acting.',
      'Record each PHI access as a FHIR AuditEvent / Provenance entry; never log PHI in application logs.',
      'Persist clinical content in openEHR archetypes/templates; FHIR is the exchange format, not the storage schema.',
      'Use synthetic test data only; real names, record numbers or national identifiers never appear in specs, fixtures or logs.'
    ]
  },
  lintRules: [
    requireTag({
      id: 'GHK401', name: 'FHIR resource declared', severity: 'warning', ns: 'fhir',
      format: new RegExp(`^(${FHIR_RESOURCES.join('|')})$`), example: '@fhir:Patient',
      why: 'The FHIR resource is the API contract of the capability.'
    }),
    requireCompanion({
      id: 'GHK402', name: 'PHI access is authorized', severity: 'error',
      when: /\b(patient|diagnos\w*|medical record|clinical|prescription|lab result|allerg\w*|paciente|historia cl[ií]nica|cl[ií]nic[oa]|receta|resultado de laboratorio)\b/i,
      require: /\b(consent\w*|authori[sz]\w*|permission|scope|role|autoriza\w*|permiso|rol)\b/i,
      message: 'Scenario handles protected health information without a consent or authorization step.',
      suggestion: 'Add a Given step that states the caller authorization or patient consent, and a scenario where it is missing.'
    }),
    forbidPattern({
      id: 'GHK403', name: 'Synthetic data only', severity: 'warning', raw: true,
      pattern: /\b\d{3}-\d{2}-\d{4}\b|[\w.+-]+@[\w-]+\.[\w.]+/,
      message: 'Step contains what looks like a real identifier (SSN or e-mail).',
      suggestion: 'Use obviously synthetic values (e.g. "patient-001") in health specifications.'
    })
  ]
};
