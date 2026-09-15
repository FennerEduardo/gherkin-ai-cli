/* ==========================================================================
   gherkin-ai-cli - Requirement Validator (Enhanced)
   
   Validates .md and free-text requirement documents before agent processing.
   Detects ambiguity, missing error scenarios, structural gaps, and scores
   overall document quality for enterprise readiness.
   ========================================================================== */

export interface RequirementValidation {
  isValid: boolean;
  issues: RequirementIssue[];
  score: number;                    // 0-100 quality score
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export type RequirementIssueType =
  | 'missing_acceptance_criteria'
  | 'ambiguous_language'
  | 'no_actionable_blocks'
  | 'too_broad'
  | 'missing_error_scenarios'
  | 'no_priority_or_scope'
  | 'missing_data_contracts';

export type RequirementSeverity = 'error' | 'warning' | 'info';

export interface RequirementIssue {
  type: RequirementIssueType;
  severity: RequirementSeverity;
  message: string;
  suggestion: string;
}

// Ambiguous terms commonly found in vague requirement documents
const AMBIGUOUS_TERMS = [
  'somehow', 'various', 'etc\\.?', 'appropriate', 'as needed',
  'flexible', 'user[- ]friendly', 'intuitive', 'simple',
  'fast', 'efficient', 'robust', 'scalable', 'seamless',
  'nice to have', 'maybe', 'possibly', 'could be',
  'in some cases', 'if applicable', 'as required', 'and so on',
  'several', 'many', 'some', 'adequate', 'reasonable'
];

const AMBIGUOUS_REGEX = new RegExp(
  `\\b(${AMBIGUOUS_TERMS.join('|')})\\b`, 'gi'
);

export function validateRequirement(content: string): RequirementValidation {
  const issues: RequirementIssue[] = [];
  let score = 100;
  
  // ── Rule 1: Acceptance Criteria or Gherkin Keywords ──────────────────
  if (!content.match(/(?:acceptance|criteria|given|when|then|scenario|feature|requirement|must|shall)/i)) {
    issues.push({
      type: 'missing_acceptance_criteria',
      severity: 'error',
      message: 'No acceptance criteria or Gherkin keywords found',
      suggestion: 'Add "Given/When/Then", "Acceptance Criteria", or "Requirements" sections to the document'
    });
    score -= 25;
  }

  // ── Rule 2: Minimum Content Length ──────────────────────────────────
  if (content.trim().length < 200) {
    issues.push({
      type: 'too_broad',
      severity: 'error',
      message: 'Requirement is too short to generate meaningful specs (< 200 chars)',
      suggestion: 'Provide detailed functional requirements with specific behaviors and edge cases (minimum 200 characters)'
    });
    score -= 25;
  } else if (content.trim().length < 500) {
    score -= 10;
  }

  // ── Rule 3: Actionable Business Entities ────────────────────────────
  if (!content.match(/(?:user|system|api|endpoint|field|data|property|action|role|permission|actor|service|module|component|entity)/i)) {
    issues.push({
      type: 'no_actionable_blocks',
      severity: 'error',
      message: 'Requirement lacks specific business domain entities or actors',
      suggestion: 'Describe specific users, actions, data fields, or API endpoints.'
    });
    score -= 20;
  }

  // ── Rule 4: Ambiguous Language Detection ────────────────────────────
  const ambiguousMatches = content.match(AMBIGUOUS_REGEX);
  if (ambiguousMatches && ambiguousMatches.length > 0) {
    const uniqueTerms = [...new Set(ambiguousMatches.map(m => m.toLowerCase()))];
    issues.push({
      type: 'ambiguous_language',
      severity: uniqueTerms.length >= 5 ? 'error' : 'warning',
      message: `Found ${ambiguousMatches.length} ambiguous term(s): ${uniqueTerms.slice(0, 5).join(', ')}${uniqueTerms.length > 5 ? '...' : ''}`,
      suggestion: 'Replace vague terms with measurable, specific criteria (e.g., "fast" → "responds within 200ms")'
    });
    score -= Math.min(20, ambiguousMatches.length * 3);
  }

  // ── Rule 5: Missing Error / Edge Case Scenarios ─────────────────────
  const hasErrorHandling = content.match(
    /(?:error|fail|invalid|reject|denied|unauthorized|forbidden|timeout|retry|rollback|edge case|exception|boundary|negative|unhappy|sad path|404|400|401|403|500|conflict)/i
  );
  if (!hasErrorHandling) {
    issues.push({
      type: 'missing_error_scenarios',
      severity: 'warning',
      message: 'No error handling, edge cases, or failure scenarios mentioned',
      suggestion: 'Describe what happens on invalid input, unauthorized access, timeouts, and system failures'
    });
    score -= 15;
  }

  // ── Rule 6: Priority / Scope Definition ─────────────────────────────
  const hasScopeOrPriority = content.match(
    /(?:priority|scope|in scope|out of scope|must have|should have|could have|won't have|moscow|p[0-3]|high priority|low priority|critical|milestone|phase|sprint|epic|story)/i
  );
  if (!hasScopeOrPriority) {
    issues.push({
      type: 'no_priority_or_scope',
      severity: 'info',
      message: 'No priority classification or scope boundaries defined',
      suggestion: 'Add a "Scope" or "Priority" section using MoSCoW (Must/Should/Could/Won\'t) or P0-P3 labels'
    });
    score -= 5;
  }

  // ── Rule 7: Data Contracts / Payload Structure ──────────────────────
  const hasDataContracts = content.match(
    /(?:payload|schema|field|column|property|type|string|number|boolean|integer|enum|json|dto|request body|response body|table|attribute)/i
  );
  if (!hasDataContracts) {
    issues.push({
      type: 'missing_data_contracts',
      severity: 'warning',
      message: 'No data structure, payload fields, or schema definitions found',
      suggestion: 'Define expected request/response fields, data types, and validation rules'
    });
    score -= 10;
  }
  
  // Clamp score
  score = Math.max(0, Math.min(100, score));

  const estimatedComplexity = content.length > 2000 ? 'high' : (content.length > 500 ? 'medium' : 'low');

  // Only block on errors, not warnings/info
  const hasBlockingIssues = issues.some(i => i.severity === 'error');

  return {
    isValid: !hasBlockingIssues,
    issues,
    score,
    estimatedComplexity
  };
}
