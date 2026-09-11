import { ValidatorContext, ValidationResult } from './index';

/**
 * Validador para Vue 3 y Pinia
 * Asegura que no se muta estado global sin usar Pinia, o patrones antipatrón en Vue.
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
        
        // Mutación de variables globales directas o uso de window para estado
        if (lowerLine.includes('window.') && lowerLine.includes('=')) {
          result.warnings.push(`Práctica cuestionable / Questionable practice: Posible mutación de estado global (window) detectada en Vue en la línea ${index + 1} de ${file.path}. Usa Pinia. / Possible global state mutation (window) detected in Vue at line ${index + 1} of ${file.path}. Use Pinia.`);
        }

        // Uso directo de localStorage en componentes en lugar de stores/composables
        if (file.path.endsWith('.vue') && lowerLine.includes('localstorage.setitem')) {
          result.warnings.push(`Advertencia Arquitectónica / Architectural Warning: Acceso directo a localStorage dentro de un componente Vue en la línea ${index + 1} de ${file.path}. Delega esta persistencia a Pinia o un Composable. / Direct access to localStorage inside a Vue component at line ${index + 1} of ${file.path}. Delegate this persistence to Pinia or a Composable.`);
        }

        // Verificar uso de EventBus genérico que es anti-patrón en Vue 3
        if (lowerLine.includes('eventbus.$emit') || lowerLine.includes('new vue(')) {
          result.errors.push(`Antipatrón Vue 3 / Vue 3 Anti-pattern: Uso de EventBus global ($emit) o instanciación de Vue 2 en la línea ${index + 1} de ${file.path}. Vue 3 requiere Pinia o mitt. / Use of global EventBus ($emit) or Vue 2 instantiation at line ${index + 1} of ${file.path}. Vue 3 requires Pinia or mitt.`);
          result.valid = false;
        }
      });
    }
  });

  return result;
}

