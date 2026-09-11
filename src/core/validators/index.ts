import { validateDotNetCqrs } from './dotnet-cqrs-validator';
import { validateAngularNgRx } from './angular-ngrx-validator';
import { validateC4Sync } from './c4-sync-validator';
import { validateFinancialGates } from './financial-gates';
import { validateTelemetry } from './telemetry-validator';
import { validateVuePiniaRules } from './vue-validator';
import { validateJavaSpring } from './java-spring-validator';
import { validateReactRules } from './react-validator';

export interface ValidatorContext {
  files: { path: string; content: string }[];
  rules: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function runAllValidators(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  
  const dotnetResult = validateDotNetCqrs(context);
  const angularResult = validateAngularNgRx(context);
  const c4Result = validateC4Sync(context);
  const financialResult = validateFinancialGates(context);
  const telemetryResult = validateTelemetry(context);
  const vueResult = validateVuePiniaRules(context);
  const javaResult = validateJavaSpring(context);
  const reactResult = validateReactRules(context);

  result.valid = dotnetResult.valid && angularResult.valid && c4Result.valid && financialResult.valid && telemetryResult.valid && vueResult.valid && javaResult.valid && reactResult.valid;
  result.errors.push(...dotnetResult.errors, ...angularResult.errors, ...c4Result.errors, ...financialResult.errors, ...telemetryResult.errors, ...vueResult.errors, ...javaResult.errors, ...reactResult.errors);
  result.warnings.push(...dotnetResult.warnings, ...angularResult.warnings, ...c4Result.warnings, ...financialResult.warnings, ...telemetryResult.warnings, ...vueResult.warnings, ...javaResult.warnings, ...reactResult.warnings);

  return result;
}


