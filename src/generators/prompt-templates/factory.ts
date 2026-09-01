import { PromptTemplate, PromptTemplateContext } from './base';
import { fallbackTemplate } from './stacks/fallback';
import { nestjsTemplate } from './stacks/nestjs';
import { laravelTemplate } from './stacks/laravel';
import { springBootTemplate } from './stacks/spring-boot';
import { dotnetTemplate } from './stacks/dotnet';
import { rubyOnRailsTemplate } from './stacks/ruby-on-rails';
import { reactNativeTemplate } from './stacks/react-native';
import { flutterTemplate } from './stacks/flutter';
import { ionicTemplate } from './stacks/ionic';
import { frontendWebTemplate } from './stacks/frontend-web';
import { pythonBackendTemplate } from './stacks/python-backend';
import { goBackendTemplate } from './stacks/go-backend';
import { rustBackendTemplate } from './stacks/rust-backend';
import { desktopClientTemplate } from './stacks/desktop-client';
import { nativeMobileTemplate } from './stacks/native-mobile';

const templates: PromptTemplate[] = [
  frontendWebTemplate,
  nestjsTemplate,
  laravelTemplate,
  springBootTemplate,
  dotnetTemplate,
  rubyOnRailsTemplate,
  pythonBackendTemplate,
  goBackendTemplate,
  rustBackendTemplate,
  reactNativeTemplate,
  flutterTemplate,
  ionicTemplate,
  desktopClientTemplate,
  nativeMobileTemplate,
  fallbackTemplate // Must be last
];

export function resolvePromptTemplate(config: any): PromptTemplate {
  for (const template of templates) {
    if (template.match(config)) {
      return template;
    }
  }
  return fallbackTemplate;
}
