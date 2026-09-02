/* ==========================================================================
   gherkin-ai-cli - Flutter (Dart) Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateFlutterPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const moduleName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  const stepDefCode = `// flutter_test Step Definitions for ${parsed.featureName}
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('${parsed.featureName.replace(/'/g, "\\'")}', () {
    
${parsed.scenarios.map(sc => `
    testWidgets('${sc.name.replace(/'/g, "\\'")}', (WidgetTester tester) async {
${sc.steps.map(st => `
      // ${st.keyword.trim()} ${st.text}
      // TODO: Implement step
`).join('')}
    });
`).join('')}
  });
}
`;

  return [
    {
      filename: `test/${moduleName}_test.dart`,
      content: stepDefCode
    }
  ];
}
