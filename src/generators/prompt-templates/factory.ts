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

const templates: PromptTemplate[] = [
  nestjsTemplate,
  laravelTemplate,
  springBootTemplate,
  dotnetTemplate,
  rubyOnRailsTemplate,
  reactNativeTemplate,
  flutterTemplate,
  ionicTemplate,
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
