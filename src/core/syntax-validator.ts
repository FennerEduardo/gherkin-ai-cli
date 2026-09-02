import { Project } from 'ts-morph';
import chalk from 'chalk';

/**
 * Validates TypeScript syntax in-memory before writing to disk.
 * Returns true if valid, false if syntax errors exist.
 */
export function validateTypeScriptSyntax(filename: string, content: string): boolean {
  if (!filename.endsWith('.ts') && !filename.endsWith('.tsx')) {
    return true; // We only validate TS files for now
  }

  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(filename, content);
    
    // Check syntactic diagnostics (fast) rather than semantic (slow, requires full project)
    const diagnostics = sourceFile.getPreEmitDiagnostics();
    const errors = diagnostics.filter(d => d.getCategory() === 1); // Error category

    if (errors.length > 0) {
      console.log(chalk.yellow(`   ⚠️ Pre-validation failed for ${filename}:`));
      for (const diag of errors.slice(0, 3)) {
        console.log(chalk.yellow(`      - ${diag.getMessageText()}`));
      }
      return false;
    }
    return true;
  } catch (err: any) {
    console.log(chalk.yellow(`   ⚠️ Pre-validation exception for ${filename}: ${err.message}`));
    return false;
  }
}
