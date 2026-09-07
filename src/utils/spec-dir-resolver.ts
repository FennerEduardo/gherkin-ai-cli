import fs from 'fs';
import path from 'path';

/**
 * Resuelve el directorio de especificaciones Gherkin.
 * Prioridad: config.specDir > features/ > specs/ > error
 */
export function resolveSpecDir(configSpecDir?: string, cwd: string = process.cwd()): string {
  const targetDir = process.env.GHK_SPEC_DIR || configSpecDir;
  
  if (targetDir) {
    const resolved = path.resolve(cwd, targetDir);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `Spec directory "${targetDir}" not found at ${resolved}.\n` +
        `  → Fix: Create the directory or update "specDir" in gherkin-ai.config.json`
      );
    }
    return resolved;
  }

  const candidates = ['features', 'specs', 'spec'];
  for (const dir of candidates) {
    const candidate = path.join(cwd, dir);
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `No spec directory found. Looked for: ${candidates.join(', ')}\n` +
    `  → Fix: Create a "features/" directory or set "specDir" in gherkin-ai.config.json`
  );
}
