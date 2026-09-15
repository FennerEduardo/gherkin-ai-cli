import { ValidatorContext, ValidationResult } from './index';

/**
 * Validator for Vue 3 and Pinia
 * Ensures global state is not mutated without Pinia, and detects anti-patterns in Vue.
 */
export function validateVuePiniaRules(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  context.files.forEach(file => {
    if (file.path.endsWith('.vue') || file.path.endsWith('.ts') || file.path.endsWith('.js')) {
      const lines = file.content.split('\n');
      lines.forEach((line, index) => {
        const lowerLine = line.toLowerCase();
        
        // Direct global variable mutation or using window for state
        if (lowerLine.includes('window.') && lowerLine.includes('=')) {
          result.warnings.push(`Questionable practice: Possible global state mutation (window) detected in Vue at line ${index + 1} of ${file.path}. Use Pinia.`);
        }

        // Direct localStorage usage in components instead of stores/composables
        if (file.path.endsWith('.vue') && lowerLine.includes('localstorage.setitem')) {
          result.warnings.push(`Architectural Warning: Direct access to localStorage inside a Vue component at line ${index + 1} of ${file.path}. Delegate this persistence to Pinia or a Composable.`);
        }

        // Check for generic EventBus usage which is an anti-pattern in Vue 3
        if (lowerLine.includes('eventbus.$emit') || lowerLine.includes('new vue(')) {
          result.errors.push(`Vue 3 Anti-pattern: Use of global EventBus ($emit) or Vue 2 instantiation at line ${index + 1} of ${file.path}. Vue 3 requires Pinia or mitt.`);
          result.valid = false;
        }
      });
    }
  });

  return result;
}

