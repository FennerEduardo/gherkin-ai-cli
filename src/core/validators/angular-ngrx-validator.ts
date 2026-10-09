import { ValidatorContext, ValidationResult } from './dotnet-cqrs-validator';
import { tf } from '../../utils/i18n-cli';

export function validateAngularNgRx(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  
  if (!context.rules.includes('strictLayerBoundaries')) {
    return result;
  }

  context.files.filter(f => f.path.endsWith('.ts') && !f.path.endsWith('.spec.ts')).forEach(file => {
    const isComponent = file.path.includes('.component.ts');
    const isService = file.path.includes('.service.ts');
    
    if (isComponent) {
      if (file.content.includes('HttpClient')) {
        result.valid = false;
        result.errors.push(tf('valAngularHttpInComponent', { file: file.path }));
      }
      
      if (file.content.includes('signalStore') || file.content.includes('@ngrx/store')) {
        // Ok, Angular Signal Store o NgRx Store en uso
      }
    }

    if (isService) {
      if (file.content.includes('@Component')) {
        result.warnings.push(tf('valAngularServiceComponent', { file: file.path }));
      }
    }
  });

  return result;
}

