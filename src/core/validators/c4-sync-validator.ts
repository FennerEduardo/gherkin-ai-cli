import { ValidatorContext, ValidationResult } from './index';

export function validateC4Sync(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  
  const c4Files = context.files.filter(f => f.path.endsWith('.md') && f.content.includes('C4Context'));
  const csharpFiles = context.files.filter(f => f.path.endsWith('.cs'));

  if (c4Files.length === 0) {
    result.warnings.push('Advertencia / Warning: No se encontró diagrama C4 en los archivos markdown / No C4 diagram found in markdown files.');
    return result;
  }

  // Comprobación simple de alineación / Simple alignment check
  const hasDatabaseInCode = csharpFiles.some(f => f.content.includes('DbContext') || f.content.includes('Repository'));
  const hasDatabaseInC4 = c4Files.some(f => f.content.includes('ContainerDb('));

  if (hasDatabaseInCode && !hasDatabaseInC4) {
    result.errors.push('Inconsistencia C4 / C4 Inconsistency: El código contiene persistencia (DbContext/Repository) pero el diagrama C4 no define un ContainerDb / Code contains persistence (DbContext/Repository) but C4 diagram does not define a ContainerDb.');
    result.valid = false;
  }

  return result;
}
