import { describe, it, expect } from 'vitest';
import { t } from '../src/utils/i18n-cli';

// Locales are passed explicitly: saving a global locale here would rewrite the developer's ~/.gherkin-ai/config.json.
describe('CLI Multilingual i18n & Prompt Language Optimization', () => {

  it('should translate CLI messages correctly in English (en)', () => {
    expect(t('implementPreparing', 'en')).toContain('Preparing AI Agent Implementation Package');
    expect(t('targetFeature', 'en')).toBe('Target Feature:');
    expect(t('tokenEfficiency', 'en')).toBe('Token Efficiency:');
    expect(t('auditCleared', 'en')).toContain('cleared successfully');
  });

  it('should translate CLI messages correctly in Spanish (es)', () => {
    expect(t('implementPreparing', 'es')).toContain('Preparando el Paquete de Implementación');
    expect(t('targetFeature', 'es')).toBe('Feature Objetivo:');
    expect(t('tokenEfficiency', 'es')).toBe('Eficiencia de Tokens:');
    expect(t('auditCleared', 'es')).toContain('vaciado exitosamente');
  });

  it('should include prompt language efficiency rationale notice in Spanish i18n', () => {
    const notice = t('promptLanguageNotice', 'es');
    expect(notice).toContain('Nota de Eficiencia');
    expect(notice).toContain('Inglés');
    expect(notice).toContain('densidad de tokens');
  });
});
