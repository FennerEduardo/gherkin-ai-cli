import type { IndustryProfile } from './types';
import { glossaryRule, requireCompanion } from './lint-helpers';

const GLOSSARY = [
  { term: 'Learner', avoid: ['pupil'], definition: 'IMS role of the person who takes a course (LTI, Caliper, OneRoster "student").' },
  { term: 'Class', avoid: ['course group', 'grupo de curso'], definition: 'OneRoster: an instance of a course in a term, with its own enrollments.' }
];

export const education: IndustryProfile = {
  id: 'education',
  label: 'Education',
  summary: 'Learning platforms and school systems: IMS OneRoster rosters, LTI 1.3 tool launches and Caliper / xAPI learning events, with the data protection rules for minors.',
  aliases: ['edtech', 'educacion', 'educación', 'lms', 'learning', 'school', 'k12', 'higher-ed'],
  standards: [
    { id: 'OneRoster', name: '1EdTech OneRoster', version: '1.2', url: 'https://www.1edtech.org/standards/oneroster', scope: 'Rostering data: organizations, users, courses, classes, enrollments, results.' },
    { id: 'LTI', name: '1EdTech Learning Tools Interoperability', version: '1.3', url: 'https://www.1edtech.org/standards/lti', scope: 'Secure launches of external tools (OIDC + signed JWT), deep linking and grade passback (AGS).' },
    { id: 'Caliper', name: '1EdTech Caliper Analytics', version: '1.2', url: 'https://www.1edtech.org/standards/caliper', scope: 'Learning activity events; xAPI statements where an LRS is used instead.' }
  ],
  canonicalModel: 'OneRoster entities (Org, User, Course, Class, Enrollment, LineItem, Result) with Caliper / xAPI events',
  glossary: GLOSSARY,
  recommendedArchitectures: ['hexagonal', 'microservices', 'event-driven'],
  recommendedPatterns: ['consent-ledger', 'guardian-delegation', 'transactional-outbox', 'audit-trail', 'data-minimization'],
  compliance: [
    'Minors: consent of the parent or legal representative (Colombia Ley 1581 de 2012 art. 7 and Decreto 1377, COPPA in the US, GDPR art. 8, Brazil LGPD art. 14)',
    'Student education records: access only by the student, the legal representative and school officials with a legitimate interest (FERPA in the US)',
    'Data minimization and retention limits for learner data; no profiling of minors for advertising',
    'Accessibility of learner-facing interfaces (WCAG 2.2 AA)'
  ],
  tagNamespaces: ['oneroster', 'lti', 'caliper', 'capability'],
  approvalPaths: ['**/minors/**', '**/consent/**', '**/guardians/**', '**/legal-representatives/**', '**/grades/**'],
  guidance: {
    compact: 'Education (OneRoster + LTI 1.3 + Caliper): name rosters with OneRoster entities; a minor is only enrolled or contacted after the recorded consent of the legal representative; grades and records are visible to the learner, the representative and authorized staff only; every access to a learner record is audited.',
    rules: [
      'Model rosters with OneRoster entities (Org, User, Course, Class, Enrollment, LineItem, Result) and keep their sourcedId as the external identifier.',
      'A minor is not invited, enrolled or contacted until the consent of the parent or legal representative is recorded; withdrawing the consent stops the processing.',
      'Grades, attendance and other education records are readable only by the learner, the legal representative with delegated access and staff with a legitimate interest; every other caller gets 403.',
      'Record consent, delegation and every access to a learner record in an append-only audit trail (who, what, when, legal basis).',
      'Integrate external tools through LTI 1.3 (OIDC launch, signed JWT, Assignment and Grade Services), never by sharing credentials.',
      'Use synthetic learner data in specifications and fixtures; never real names, national identifiers or birth dates of real children.'
    ]
  },
  lintRules: [
    requireCompanion({
      id: 'GHK901', name: 'Minors require the consent of their legal representative', severity: 'error', scope: 'feature',
      when: /\b(minors?|under 18|underage|child(ren)?|menor(es)?( de edad)?|ni[ñn][oa]s?)\b/i,
      require: /\b(consent\w*|legal representative|guardian|parent\w*|consentimiento|representante legal|acudiente|padre|madre|tutor)\b/i,
      message: 'Feature handles minors but no scenario involves the consent of a parent or legal representative.',
      suggestion: 'Add a scenario where the legal representative grants (and one where they refuse or withdraw) consent before the minor is processed.'
    }),
    requireCompanion({
      id: 'GHK902', name: 'Education records are access-controlled', severity: 'warning', scope: 'feature',
      when: /\b(grades?|gradebook|transcripts?|report cards?|attendance|academic records?|calificaci[oó]n(es)?|notas|bolet[ií]n|asistencia|expediente acad[eé]mico)\b/i,
      require: /\b(authori[sz]\w*|unauthori[sz]ed|permission|role|access|denied|refused|cannot|forbidden|autoriza\w*|permiso|rol|acceso|no puede|denegad[oa])\b/i,
      message: 'Feature exposes education records but no scenario says who may not see them.',
      suggestion: 'Add a scenario where a caller without a legitimate interest (another learner, an unlinked representative) is refused.'
    }),
    glossaryRule({ id: 'GHK903', name: 'IMS / OneRoster vocabulary', severity: 'info', entries: GLOSSARY })
  ]
};
