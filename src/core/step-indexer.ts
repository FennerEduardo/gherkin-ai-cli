/* ==========================================================================
   gherkin-ai-cli - Multi-Stack Step Indexer Engine
   ========================================================================== */

import { Project, CallExpression, SyntaxKind } from 'ts-morph';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

export interface ExtractedStep {
  keyword: string; // 'Given', 'When', 'Then', 'step', 'Dado', 'Cuando', 'Entonces'
  pattern: string; // string or regex text
  filePath: string;
  language?: string;
  lineNumber?: number;
}

export interface IStepParser {
  parse(workspaceRoot: string): ExtractedStep[];
}

export class TypeScriptStepParser implements IStepParser {
  public parse(workspaceRoot: string): ExtractedStep[] {
    const steps: ExtractedStep[] = [];
    const project = new Project();

    const searchGlobs = [
      path.join(workspaceRoot, 'cypress/support/**/*.ts'),
      path.join(workspaceRoot, 'cypress/support/**/*.js'),
      path.join(workspaceRoot, 'e2e/steps/**/*.ts'),
      path.join(workspaceRoot, 'tests/steps/**/*.ts'),
      path.join(workspaceRoot, 'features/step_definitions/**/*.ts'),
      path.join(workspaceRoot, 'src/**/*.step.ts'),
      path.join(workspaceRoot, 'src/**/*.steps.ts'),
    ];

    try {
      project.addSourceFilesAtPaths(searchGlobs);
      const sourceFiles = project.getSourceFiles();

      for (const sf of sourceFiles) {
        const callExpressions = sf.getDescendantsOfKind(SyntaxKind.CallExpression) as unknown as CallExpression[];
        
        for (const callExpr of callExpressions) {
          const expression = callExpr.getExpression();
          const funcName = expression.getText();

          if (['Given', 'When', 'Then', 'step', 'dado', 'cuando', 'entonces', 'Dado', 'Cuando', 'Entonces'].includes(funcName)) {
            const args = callExpr.getArguments();
            if (args.length > 0) {
              const firstArg = args[0];
              let pattern = '';
              
              if (firstArg.getKindName() === 'StringLiteral' || firstArg.getKindName() === 'NoSubstitutionTemplateLiteral') {
                pattern = firstArg.getText().replace(/^['"`]/, '').replace(/['"`]$/, '');
              } else if (firstArg.getKindName() === 'RegularExpressionLiteral') {
                pattern = firstArg.getText();
              }

              if (pattern) {
                steps.push({
                  keyword: funcName,
                  pattern,
                  filePath: sf.getFilePath(),
                  language: 'TypeScript'
                });
              }
            }
          }
        }
      }
    } catch (e: any) {
      logger.debug(`TypeScriptStepParser notice: ${e.message}`);
    }

    return steps;
  }
}

export class RegexStepParser implements IStepParser {
  public parse(workspaceRoot: string): ExtractedStep[] {
    const steps: ExtractedStep[] = [];

    // Step annotations in Java, Python, C#, Ruby, Go
    // Examples:
    // Java: @Given("I am logged in as {string}") or @Given("^I am logged in$")
    // Python: @given("I am logged in as {string}") or @when(r'...')
    // C#: [Given(@"I am logged in")] or [When("...")]
    // Ruby: Given(/^I am logged in$/) do
    const patterns = [
      // Java / Kotlin Annotations
      { regex: /@(Given|When|Then|And|But|Dado|Cuando|Entonces)\s*\(\s*["']([^"']+)["']\s*\)/gi, lang: 'Java' },
      // Python Behave / Cucumber-Py
      { regex: /@(given|when|then|step|dado|cuando|entonces)\s*\(\s*r?["']([^"']+)["']\s*\)/gi, lang: 'Python' },
      // C# ReSpec / SpecFlow
      { regex: /\[(Given|When|Then|GivenAsync|WhenAsync|ThenAsync)\s*\(\s*@?["']([^"']+)["']\s*\)\]/gi, lang: 'C#' },
      // Ruby Cucumber
      { regex: /(Given|When|Then|Dado|Cuando|Entonces)\s*\(\s*\/(.+)\/\s*\)\s*do/gi, lang: 'Ruby' },
    ];

    const fileExtensions = ['.java', '.kt', '.py', '.cs', '.rb', '.go'];

    const scanDirectory = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'build' || entry.name === '.git' || entry.name === 'venv' || entry.name === '__pycache__') {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          scanDirectory(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (fileExtensions.includes(ext)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');

              lines.forEach((line, idx) => {
                for (const item of patterns) {
                  item.regex.lastIndex = 0; // reset state
                  let match: RegExpExecArray | null;
                  while ((match = item.regex.exec(line)) !== null) {
                    steps.push({
                      keyword: match[1],
                      pattern: match[2],
                      filePath: fullPath,
                      language: item.lang,
                      lineNumber: idx + 1
                    });
                  }
                }
              });
            } catch {
              // Ignore unreadable files
            }
          }
        }
      }
    };

    scanDirectory(workspaceRoot);
    return steps;
  }
}

export class StepIndexer {
  private parsers: IStepParser[] = [
    new TypeScriptStepParser(),
    new RegexStepParser()
  ];

  public getAvailableSteps(workspaceRoot: string): ExtractedStep[] {
    const allSteps: ExtractedStep[] = [];
    for (const parser of this.parsers) {
      try {
        const parsed = parser.parse(workspaceRoot);
        allSteps.push(...parsed);
      } catch (e: any) {
        logger.error(`Error parsing steps: ${e.message}`);
      }
    }
    return allSteps;
  }
}
