/* ==========================================================================
   gherkin-ai-cli - 'create' Command Handler (Localized Interactive Spec Wizard)
   ========================================================================== */

import path from 'path';
import inquirer from 'inquirer';
import { handleAddCommand } from './add';
import { ensureCliLanguage, t } from '../utils/i18n-cli';
import { fileExistsSync, writeFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';

export async function handleCreateCommand(options: { output?: string; target?: string; lang?: string; caveman?: boolean }): Promise<void> {
  logger.banner();

  const locale = await ensureCliLanguage(options.lang);
  const isEs = locale === 'es';

  logger.info(isEs ? 'Asistente Interactivo Gherkin - Creación paso a paso' : 'Interactive Gherkin Spec Wizard - Step-by-step feature creator');

  if (options.caveman) {
    logger.info(isEs ? 'Modo Caveman Activado - Ingreso Rápido' : 'Caveman Mode Activated - Quick Input');
    const { quickDesc } = await inquirer.prompt([{
      type: 'input',
      name: 'quickDesc',
      message: isEs ? 'Describe lo que quieres construir con tus propias palabras:' : 'Describe what you want to build in your own words:',
      validate: (input: string) => input.trim().length > 0 || 'Description cannot be empty.'
    }]);

    const featureKw = isEs ? 'Característica:' : 'Feature:';
    const scKw = isEs ? 'Escenario:' : 'Scenario:';
    const givenKw = isEs ? 'Dado' : 'Given';

    let gherkinContent = `${featureKw} Requirement generated from Caveman Mode\n`;
    gherkinContent += `  ${scKw} Main implementation flow\n`;
    gherkinContent += `    ${givenKw} the following requirement:\n      """\n      ${quickDesc}\n      """\n`;

    const defaultFileName = 'caveman_' + Date.now() + '.feature';
    const targetSpecPath = options.output
      ? path.resolve(process.cwd(), options.output)
      : path.resolve(process.cwd(), 'specs', defaultFileName);

    writeFileSync(targetSpecPath, gherkinContent);
    logger.success(`${t('specCreated', locale)} ${targetSpecPath}`);

    console.log('\n------------------------------------------------------------');
    console.log(gherkinContent);
    console.log('------------------------------------------------------------\n');

    const injectAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'inject',
        message: t('injectPrompt', locale),
        default: true
      }
    ]);

    if (injectAnswer.inject) {
      await handleAddCommand({
        feature: targetSpecPath,
        target: options.target
      });
    }
    return;
  }


  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'featureName',
      message: t('featureNamePrompt', locale),
      default: isEs ? 'Autenticación de Doble Factor 2FA' : 'Two Factor Authentication 2FA',
      validate: (input: string) => input.trim().length > 0 || 'Name cannot be empty.'
    },
    {
      type: 'input',
      name: 'actor',
      message: t('actorPrompt', locale),
      default: isEs ? 'usuario autenticado del sistema' : 'authenticated system user'
    },
    {
      type: 'input',
      name: 'action',
      message: t('actionPrompt', locale),
      default: isEs ? 'habilitar y verificar un código OTP de dos factores' : 'enable and verify a two-factor OTP code'
    },
    {
      type: 'input',
      name: 'outcome',
      message: t('outcomePrompt', locale),
      default: isEs ? 'proteger mi cuenta contra accesos no autorizados' : 'protect my account against unauthorized access'
    },
    {
      type: 'input',
      name: 'scenarioName',
      message: t('scenarioNamePrompt', locale),
      default: isEs ? 'Habilitar y verificar código 2FA exitosamente' : 'Enable and verify 2FA code successfully'
    }
  ]);

  const steps: Array<{ keyword: string; text: string }> = [];

  console.log(isEs ? '\n--- Asistente de Pasos Gherkin (Dado / Cuando / Entonces) ---' : '\n--- Step-by-step Gherkin Scenario Builder (Given / When / Then) ---');

  let addMore = true;
  let defaultKw = isEs ? 'Dado' : 'Given';

  const choicesEn = ['Given', 'When', 'Then', 'And', 'But'];
  const choicesEs = ['Dado', 'Cuando', 'Entonces', 'Y', 'Pero'];

  while (addMore) {
    const stepAnswers = await inquirer.prompt([
      {
        type: 'list',
        name: 'keyword',
        message: t('stepKeywordPrompt', locale),
        choices: isEs ? choicesEs : choicesEn,
        default: defaultKw
      },
      {
        type: 'input',
        name: 'text',
        message: t('stepDescPrompt', locale),
        validate: (input: string) => input.trim().length > 0 || 'Description cannot be empty.'
      },
      {
        type: 'confirm',
        name: 'next',
        message: t('addAnotherStepPrompt', locale),
        default: true
      }
    ]);

    steps.push({ keyword: stepAnswers.keyword, text: stepAnswers.text });

    if (['Dado', 'Given'].includes(stepAnswers.keyword)) defaultKw = isEs ? 'Cuando' : 'When';
    else if (['Cuando', 'When'].includes(stepAnswers.keyword)) defaultKw = isEs ? 'Entonces' : 'Then';
    else defaultKw = isEs ? 'Y' : 'And';

    addMore = stepAnswers.next;
  }

  // Construct Gherkin File Content
  const featureKw = isEs ? 'Característica:' : 'Feature:';
  const asKw = isEs ? 'Como' : 'As a';
  const wantKw = isEs ? 'Quiero' : 'I want to';
  const soKw = isEs ? 'Para' : 'So that';
  const scKw = isEs ? 'Escenario:' : 'Scenario:';

  let gherkinContent = `${featureKw} ${answers.featureName}\n`;
  gherkinContent += `  ${asKw} ${answers.actor}\n`;
  gherkinContent += `  ${wantKw} ${answers.action}\n`;
  gherkinContent += `  ${soKw} ${answers.outcome}\n\n`;
  gherkinContent += `  ${scKw} ${answers.scenarioName}\n`;

  steps.forEach(st => {
    gherkinContent += `    ${st.keyword} ${st.text}\n`;
  });

  const defaultFileName = answers.featureName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.feature';
  const targetSpecPath = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(process.cwd(), 'specs', defaultFileName);

  writeFileSync(targetSpecPath, gherkinContent);
  logger.success(`${t('specCreated', locale)} ${targetSpecPath}`);

  console.log('\n------------------------------------------------------------');
  console.log(gherkinContent);
  console.log('------------------------------------------------------------\n');

  // Prompt to immediately inject contracts into project
  const injectAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'inject',
      message: t('injectPrompt', locale),
      default: true
    }
  ]);

  if (injectAnswer.inject) {
    await handleAddCommand({
      feature: targetSpecPath,
      target: options.target
    });
  }
}
