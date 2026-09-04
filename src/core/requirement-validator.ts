export interface RequirementValidation {
  isValid: boolean;
  issues: RequirementIssue[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface RequirementIssue {
  type: 'missing_acceptance_criteria' | 'ambiguous_requirement' | 'no_actionable_blocks' | 'too_broad';
  message: string;
  suggestion: string;
}

export function validateRequirement(content: string): RequirementValidation {
  const issues: RequirementIssue[] = [];
  
  // Detect acceptance criteria or gherkin keywords
  if (!content.match(/(?:acceptance|criteria|given|when|then|scenario|feature)/i)) {
    issues.push({
      type: 'missing_acceptance_criteria',
      message: 'No acceptance criteria or Gherkin keywords found',
      suggestion: 'Add "Given/When/Then" or "Acceptance Criteria" sections to the document'
    });
  }

  // Detect vague requirements
  if (content.length < 100) {
    issues.push({
      type: 'too_broad',
      message: 'Requirement is too short to generate meaningful specs',
      suggestion: 'Provide detailed functional requirements with specific behaviors and edge cases'
    });
  }
  
  const estimatedComplexity = content.length > 2000 ? 'high' : (content.length > 500 ? 'medium' : 'low');

  return {
    isValid: issues.length === 0,
    issues,
    estimatedComplexity
  };
}
