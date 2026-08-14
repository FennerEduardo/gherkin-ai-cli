/* ==========================================================================
   gherkin-ai-cli - 'create' Command Handler (Interactive Gherkin Spec Wizard)
   ========================================================================== */

import path from 'path';
import inquirer from 'inquirer';
import { handleAddCommand } from './add';
import { fileExistsSync, writeFileSync, ensureDirSync } from '../utils/file-system';
import { logger } from '../utils/logger';

export async function handleCreateCommand(options: { output?: string; target?: string }): Promise<void> {
  logger.banner();
  logger.info('Interactive Gherkin Spec Wizard - Step-by-step feature creator');

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'featureName',
      message: 'Feature Name (Nombre de la Feature):',
      default: 'Autenticación de Doble Factor 2FA',
      validate: (input: string) => input.trim().length > 0 || 'Feature name cannot be empty.'
    },
    {
      type: 'input',
      name: 'actor',
      message: 'Actor (Como... / As a...):',
      default: 'usuario autenticado del sistema'
    },
    {
      type: 'input',
      name: 'action',
      message: 'Action (Quiero... / I want to...):',
      default: 'habilitar y verificar un código OTP de dos factores (2FA)'
    },
    {
      type: 'input',
      name: 'outcome',
      message: 'Benefit (Para... / So that...):',
      default: 'proteger mi cuenta contra accesos no autorizados'
    },
    {
      type: 'input',
      name: 'scenarioName',
      message: 'Scenario Name (Nombre del Escenario):',
      default: 'Habilitar y verificar código 2FA exitosamente'
    }
  ]);

  const steps: Array<{ keyword: string; text: string }> = [];

  console.log('\n--- Step-by-step Gherkin Scenario Builder (Given / When / Then) ---');

  let addMore = true;
  let defaultKw = 'Dado';

  while (addMore) {
    const stepAnswers = await inquirer.prompt([
      {
        type: 'list',
        name: 'keyword',
        message: 'Step Keyword (Palabra clave):',
        choices: ['Dado', 'Cuando', 'Entonces', 'Y', 'Pero', 'Given', 'When', 'Then', 'And', 'But'],
        default: defaultKw
      },
      {
        type: 'input',
        name: 'text',
        message: 'Step Description (Descripción del paso):',
        validate: (input: string) => input.trim().length > 0 || 'Step description cannot be empty.'
      },
      {
        type: 'confirm',
        name: 'next',
        message: 'Añadir otro paso (Add another step)?',
        default: true
      }
    ]);

    steps.push({ keyword: stepAnswers.keyword, text: stepAnswers.text });

    if (stepAnswers.keyword === 'Dado' || stepAnswers.keyword === 'Given') defaultKw = 'Cuando';
    else if (stepAnswers.keyword === 'Cuando' || stepAnswers.keyword === 'When') defaultKw = 'Entonces';
    else defaultKw = 'Y';

    addMore = stepAnswers.next;
  }

  // Construct Gherkin File Content
  let gherkinContent = `Característica: ${answers.featureName}\n`;
  gherkinContent += `  Como ${answers.actor}\n`;
  gherkinContent += `  Quiero ${answers.action}\n`;
  gherkinContent += `  Para ${answers.outcome}\n\n`;
  gherkinContent += `  Escenario: ${answers.scenarioName}\n`;

  steps.forEach(st => {
    gherkinContent += `    ${st.keyword} ${st.text}\n`;
  });

  const defaultFileName = answers.featureName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.feature';
  const targetSpecPath = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(process.cwd(), 'specs', defaultFileName);

  writeFileSync(targetSpecPath, gherkinContent);
  logger.success(`Created Gherkin feature specification at: ${targetSpecPath}`);

  console.log('\n------------------------------------------------------------');
  console.log(gherkinContent);
  console.log('------------------------------------------------------------\n');

  // Prompt to immediately inject contracts into project
  const injectAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'inject',
      message: '¿Deseas inyectar inmediatamente los contratos y prompts en tu proyecto (ghk add)?',
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
