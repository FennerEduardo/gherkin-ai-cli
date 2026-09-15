import { ValidatorContext, ValidationResult } from './index';

export function validateReactRules(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  const reactFiles = context.files.filter(f => (f.path.endsWith('.tsx') || f.path.endsWith('.jsx') || f.path.endsWith('Slice.ts')) && !f.path.endsWith('.spec.ts'));
  if (reactFiles.length === 0) return result;

  for (const file of reactFiles) {
    const content = file.content;

    // 1. Evitar llamadas a base de datos o fs directamente en componentes de React
    if (content.includes('import pg') || content.includes('import { PrismaClient }') || content.includes("require('fs')")) {
      result.errors.push(`[React-Architecture] The component ${file.path} attempts to import server/DB modules directly.`);
      result.valid = false;
    }

    // 2. Warning if Redux state is mutated directly outside createSlice
    if (content.includes('.state = ') && !content.includes('createSlice')) {
      result.warnings.push(`[React-Redux] Possible direct state mutation detected in ${file.path}. Use Redux Toolkit reducers or setState.`);
    }
  }

  return result;
}
