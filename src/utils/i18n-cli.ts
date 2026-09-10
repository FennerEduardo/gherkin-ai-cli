/* ==========================================================================
   gherkin-ai-cli - Interactive i18n Engine for CLI (EN / ES)
   ========================================================================== */

import os from 'os';
import path from 'path';
import inquirer from 'inquirer';
import { fileExistsSync, readFileSync, writeFileSync, ensureDirSync } from './file-system';

export type SupportedLocale = 'en' | 'es';

interface GlobalUserConfig {
  locale?: SupportedLocale;
}

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.gherkin-ai');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, 'config.json');

const messages = {
  en: {
    selectLanguagePrompt: 'Select preferred CLI interaction language / Selecciona el idioma preferido para la CLI:',
    langUpdated: 'CLI language successfully updated to English (en).',
    langCurrent: 'Current CLI language:',
    featureNamePrompt: 'Feature Name:',
    actorPrompt: 'Actor (As a...):',
    actionPrompt: 'Action (I want to...):',
    outcomePrompt: 'Benefit (So that...):',
    scenarioNamePrompt: 'Scenario Name:',
    stepKeywordPrompt: 'Step Keyword:',
    stepDescPrompt: 'Step Description:',
    addAnotherStepPrompt: 'Add another step?',
    specCreated: 'Created Gherkin feature specification at:',
    injectPrompt: 'Do you want to inject contracts and prompts into your project now (ghk add)?',
    featureNotFound: 'Feature file not found at:',
    askCreateInteractive: 'Would you like to create the Gherkin specification step-by-step interactively now?',
    detectingStack: 'Scanning project directory for existing stack & architecture...',
    stackDetected: 'Existing Project Stack & Architecture Detected:',
    savedConfig: 'Saved project configuration to:',
    injectingContracts: 'Injecting contracts & AI prompts into:',
    contractsInjected: 'Contracts & AI prompts injected into existing project at',
    
    // New commands & audit i18n keys
    implementPreparing: 'Preparing AI Agent Implementation Package & Master Prompt...',
    implementGenerated: 'AI AGENT IMPLEMENTATION PACKAGE GENERATED',
    targetFeature: 'Target Feature:',
    featureFile: 'Feature File:',
    authorDev: 'Author / Dev:',
    domainContract: 'Domain Contract:',
    agentPolicy: 'Agent Policy:',
    dockerSandbox: 'Docker Sandbox:',
    tokenEfficiency: 'Token Efficiency:',
    masterPrompt: 'Master Prompt:',
    auditRecord: 'Audit Record:',
    copyPromptNotice: 'COPY-PASTE THIS PROMPT DIRECTLY TO YOUR AI AGENT:',
    compactPromptNotice: 'COMPACT AI AGENT PROMPT (ULTRA LOW TOKEN COST):',
    promptLanguageNotice: 'ℹ Note: Master Prompts are intentionally generated in English for optimal LLM BPE token density and agent reasoning precision.',
    auditHeader: 'FEATURE IMPLEMENTATION & PROMPT EXECUTION INVENTORY AUDIT',
    auditCleared: 'Feature audit trail inventory cleared successfully.',
    auditDisabled: 'Audit tracking is disabled in configuration.'
  },
  es: {
    selectLanguagePrompt: 'Selecciona el idioma preferido para la CLI / Select preferred CLI interaction language:',
    langUpdated: 'Idioma de la CLI actualizado exitosamente a Español (es).',
    langCurrent: 'Idioma actual de la CLI:',
    featureNamePrompt: 'Nombre de la Feature:',
    actorPrompt: 'Actor (Como...):',
    actionPrompt: 'Acción (Quiero...):',
    outcomePrompt: 'Beneficio (Para...):',
    scenarioNamePrompt: 'Nombre del Escenario:',
    stepKeywordPrompt: 'Palabra clave del paso:',
    stepDescPrompt: 'Descripción del paso:',
    addAnotherStepPrompt: '¿Añadir otro paso?',
    specCreated: 'Especificación Gherkin creada exitosamente en:',
    injectPrompt: '¿Deseas inyectar inmediatamente los contratos y prompts en tu proyecto (ghk add)?',
    featureNotFound: 'Archivo de feature no encontrado en:',
    askCreateInteractive: '¿Deseas crear la especificación Gherkin paso a paso ahora (wizard interactivo)?',
    detectingStack: 'Escaneando directorio del proyecto en busca de stack y arquitectura...',
    stackDetected: 'Stack y Arquitectura del Proyecto Detectados:',
    savedConfig: 'Configuración guardada exitosamente en:',
    injectingContracts: 'Inyectando contratos y prompts para Agentes de IA en:',
    contractsInjected: 'Contratos y prompts inyectados exitosamente en el proyecto en',

    // New commands & audit i18n keys
    implementPreparing: 'Preparando el Paquete de Implementación y Prompt Maestro para el Agente IA...',
    implementGenerated: 'PAQUETE DE IMPLEMENTACIÓN DE AGENTE IA GENERADO',
    targetFeature: 'Feature Objetivo:',
    featureFile: 'Archivo de Feature:',
    authorDev: 'Autor / Desarrollador:',
    domainContract: 'Contrato de Dominio:',
    agentPolicy: 'Política de Gobernanza:',
    dockerSandbox: 'Entorno Sandbox Docker:',
    tokenEfficiency: 'Eficiencia de Tokens:',
    masterPrompt: 'Prompt Maestro:',
    auditRecord: 'Registro de Auditoría:',
    copyPromptNotice: 'COPIA Y PEGA ESTE PROMPT DIRECTAMENTE EN TU AGENTE DE IA:',
    compactPromptNotice: 'PROMPT COMPACTO PARA AGENTE DE IA (COSTO ULTRA BAJO EN TOKENS):',
    promptLanguageNotice: 'ℹ Nota de Eficiencia: El CLI interactúa en Español, pero las definiciones del Prompt Maestro se generan en Inglés para maximizar la densidad de tokens (~30% más económico) y la precisión de razonamiento del agente de IA.',
    auditHeader: 'AUDITORÍA DE INVENTARIO DE FEATURES Y EJECUCIÓN DE PROMPTS',
    auditCleared: 'Inventario de auditoría de ejecuciones vaciado exitosamente.',
    auditDisabled: 'El seguimiento de auditoría está desactivado en la configuración.'
  }
};

let cachedLocale: SupportedLocale | null = null;

export function getGlobalUserLocale(): SupportedLocale | null {
  if (cachedLocale) return cachedLocale;

  if (fileExistsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const raw = readFileSync(GLOBAL_CONFIG_PATH);
      const parsed: GlobalUserConfig = JSON.parse(raw);
      if (parsed.locale === 'en' || parsed.locale === 'es') {
        cachedLocale = parsed.locale;
        return parsed.locale;
      }
    } catch {
      // Ignore JSON parse error
    }
  }
  return null;
}

export function saveGlobalUserLocale(locale: SupportedLocale): void {
  ensureDirSync(GLOBAL_CONFIG_DIR);
  const current = fileExistsSync(GLOBAL_CONFIG_PATH) ? JSON.parse(readFileSync(GLOBAL_CONFIG_PATH)) : {};
  current.locale = locale;
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(current, null, 2));
  cachedLocale = locale;
}

export async function promptOrFallback(questions: any[], options?: { yes?: boolean; nonInteractive?: boolean }): Promise<any> {
  const isNonInteractive = options?.yes || options?.nonInteractive || process.env.CI === 'true' || process.env.GHK_NON_INTERACTIVE === 'true';
  if (isNonInteractive) {
    const answers: any = {};
    for (const q of questions) {
      answers[q.name] = q.default !== undefined ? q.default : (q.type === 'confirm' ? true : '');
    }
    return answers;
  }
  return await inquirer.prompt(questions);
}

export async function ensureCliLanguage(requestedLang?: string): Promise<SupportedLocale> {
  if (requestedLang === 'en' || requestedLang === 'es') {
    saveGlobalUserLocale(requestedLang);
    return requestedLang;
  }

  const existing = getGlobalUserLocale();
  if (existing) return existing;

  // Default is English if running in non-interactive CI mode
  if (!process.stdout.isTTY) {
    saveGlobalUserLocale('en');
    return 'en';
  }

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'locale',
      message: 'Select preferred CLI language / Selecciona el idioma para la CLI:',
      choices: [
        { name: '🇺🇸 English (Default)', value: 'en' },
        { name: '🇪🇸 Español', value: 'es' }
      ],
      default: 'en'
    }
  ]);

  const selectedLocale = answer.locale as SupportedLocale;
  saveGlobalUserLocale(selectedLocale);
  return selectedLocale;
}

export function t(key: keyof typeof messages['en'], locale?: SupportedLocale): string {
  const lang = locale || getGlobalUserLocale() || 'en';
  return messages[lang][key] || messages['en'][key] || key;
}
