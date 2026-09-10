/* ==========================================================================
   gherkin-ai-cli - Multi-Language AST Adapter Interface
   ========================================================================== */

export interface ParsedSymbol {
  name: string;
  kind: 'class' | 'interface' | 'function' | 'struct' | 'type' | 'endpoint';
  filePath: string;
  line: number;
}

export interface MultiLangAstAdapter {
  language: string;
  supportedExtensions: string[];
  extractSymbols(filePath: string, content: string): ParsedSymbol[];
  findMatchingSteps(filePath: string, content: string): string[];
}

export class DefaultRegexAstAdapter implements MultiLangAstAdapter {
  public language: string;
  public supportedExtensions: string[];

  constructor(language: string, extensions: string[]) {
    this.language = language;
    this.supportedExtensions = extensions;
  }

  public extractSymbols(filePath: string, content: string): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Class / Interface / Struct matching
      const classMatch = line.match(/(?:class|interface|struct|type)\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          filePath,
          line: index + 1
        });
      }

      // Function / Method matching
      const funcMatch = line.match(/(?:func|function|def|void|public|private)\s+([A-Za-z0-9_]+)\s*\(/);
      if (funcMatch && !['if', 'for', 'while', 'switch'].includes(funcMatch[1])) {
        symbols.push({
          name: funcMatch[1],
          kind: 'function',
          filePath,
          line: index + 1
        });
      }
    });

    return symbols;
  }

  public findMatchingSteps(filePath: string, content: string): string[] {
    const steps: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/(?:Given|When|Then|And|But|step|Step)\s*\(['"`](.+)['"`]\)/i);
      if (match) {
        steps.push(match[1]);
      }
    }

    return steps;
  }
}
