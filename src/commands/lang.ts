/* ==========================================================================
   gherkin-ai-cli - 'lang' Command Handler (Language Switcher)
   ========================================================================== */

import inquirer from 'inquirer';
import { ensureCliLanguage, saveGlobalUserLocale, getGlobalUserLocale, SupportedLocale, t } from '../utils/i18n-cli';
import { logger } from '../utils/logger';

export async function handleLangCommand(options: { set?: string }): Promise<void> {
  logger.banner();

  if (options.set === 'en' || options.set === 'es') {
    saveGlobalUserLocale(options.set as SupportedLocale);
    logger.success(t('langUpdated', options.set as SupportedLocale));
    return;
  }

  const current = getGlobalUserLocale() || 'en';
  logger.info(`${t('langCurrent', current)} ${current === 'es' ? '🇪🇸 Español' : '🇺🇸 English'}`);

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'locale',
      message: t('selectLanguagePrompt', current),
      choices: [
        { name: '🇺🇸 English', value: 'en' },
        { name: '🇪🇸 Español', value: 'es' }
      ],
      default: current
    }
  ]);

  const selected = answer.locale as SupportedLocale;
  saveGlobalUserLocale(selected);
  logger.success(t('langUpdated', selected));
}
