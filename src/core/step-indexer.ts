import { Project, CallExpression, SyntaxKind } from 'ts-morph';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

export interface ExtractedStep {
  keyword: string; // 'Given', 'When', 'Then', 'step'
  pattern: string; // the string or regex
  filePath: string;
}

export interface IStepParser {
  parse(workspaceRoot: string): ExtractedStep[];
}

export class TypeScriptStepParser implements IStepParser {
  public parse(workspaceRoot: string): ExtractedStep[] {
    const steps: ExtractedStep[] = [];
    const project = new Project();

    // Look in common TS/JS E2E directories
    const searchGlobs = [
      path.join(workspaceRoot, 'cypress/support/**/*.ts'),
      path.join(workspaceRoot, 'cypress/support/**/*.js'),
      path.join(workspaceRoot, 'e2e/steps/**/*.ts'),
      path.join(workspaceRoot, 'tests/steps/**/*.ts'),
      path.join(workspaceRoot, 'features/step_definitions/**/*.ts')
    ];

    project.addSourceFilesAtPaths(searchGlobs);
    const sourceFiles = project.getSourceFiles();

    for (const sf of sourceFiles) {
      // Find all call expressions like Given('...', () => {})
      const callExpressions = sf.getDescendantsOfKind(SyntaxKind.CallExpression) as unknown as CallExpression[];
      
      for (const callExpr of callExpressions) {
        const expression = callExpr.getExpression();
        const funcName = expression.getText();

        if (['Given', 'When', 'Then', 'step', 'dado', 'cuando', 'entonces'].includes(funcName)) {
          const args = callExpr.getArguments();
          if (args.length > 0) {
            const firstArg = args[0];
            let pattern = '';
            
            // If it's a string literal: Given("I login", ...)
            if (firstArg.getKindName() === 'StringLiteral' || firstArg.getKindName() === 'NoSubstitutionTemplateLiteral') {
              pattern = firstArg.getText().replace(/^['"`]/, '').replace(/['"`]$/, '');
            } 
            // If it's a regex: Given(/^I login$/, ...)
            else if (firstArg.getKindName() === 'RegularExpressionLiteral') {
              pattern = firstArg.getText();
            }

            if (pattern) {
              steps.push({
                keyword: funcName,
                pattern,
                filePath: sf.getFilePath()
              });
            }
          }
        }
      }
    }

    return steps;
  }
}

export class RegexStepParser implements IStepParser {
  public parse(workspaceRoot: string): ExtractedStep[] {
    // A fallback parser for languages without AST support yet (Python, Java, etc.)
    // Searches text for @given('...') or @When("...")
    return [];
  }
}

export class StepIndexer {
  private parsers: IStepParser[] = [
    new TypeScriptStepParser(),
    new RegexStepParser() // Fallback
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
