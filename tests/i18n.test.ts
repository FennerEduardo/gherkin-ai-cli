import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t, saveGlobalUserLocale, getGlobalUserLocale, SupportedLocale } from '../src/utils/i18n-cli';

describe('CLI Multilingual i18n & Prompt Language Optimization', () => {

  it('should translate CLI messages correctly in English (en)', () => {
    saveGlobalUserLocale('en');
    expect(t('implementPreparing')).toContain('Preparing AI Agent Implementation Package');
    expect(t('targetFeature')).toBe('Target Feature:');
    expect(t('tokenEfficiency')).toBe('Token Efficiency:');
    expect(t('auditCleared')).toContain('cleared successfully');
  });

  it('should translate CLI messages correctly in Spanish (es)', () => {
    saveGlobalUserLocale('es');
    expect(t('implementPreparing')).toContain('Preparando el Paquete de Implementación');
    expect(t('targetFeature')).toBe('Feature Objetivo:');
    expect(t('tokenEfficiency')).toBe('Eficiencia de Tokens:');
    expect(t('auditCleared')).toContain('vaciado exitosamente');
  });

  it('should include prompt language efficiency rationale notice in Spanish i18n', () => {
    saveGlobalUserLocale('es');
    const notice = t('promptLanguageNotice');
    expect(notice).toContain('Nota de Eficiencia');
    expect(notice).toContain('Inglés');
    expect(notice).toContain('densidad de tokens');
  });
});
