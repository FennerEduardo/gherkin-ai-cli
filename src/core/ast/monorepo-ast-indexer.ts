/* ==========================================================================
   gherkin-ai-cli - Monorepo AST Indexer (Lazy Loading & Memory Caching)
   ========================================================================== */

import { Project, SourceFile } from 'ts-morph';
import fs from 'fs';
import path from 'path';

export interface IndexerOptions {
  maxFilesInMemory?: number;
  skipNodeModules?: boolean;
}

export class MonorepoAstIndexer {
  private project: Project | null = null;
  private fileCache: Map<string, SourceFile> = new Map();
  private maxFiles: number;
  private rootDir: string;

  constructor(rootDir: string, options: IndexerOptions = {}) {
    this.rootDir = rootDir;
    this.maxFiles = options.maxFilesInMemory || 100;
  }

  /**
   * Initializes or returns the cached ts-morph Project
   */
  public getProject(): Project {
    if (!this.project) {
      this.project = new Project({
        compilerOptions: {
          allowJs: true,
          skipLibCheck: true
        },
        skipAddingFilesFromTsConfig: true
      });
    }
    return this.project;
  }

  /**
   * Lazy loads a specific source file into the AST Project without loading the whole repo
   */
  public loadSourceFile(filePath: string): SourceFile | null {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootDir, filePath);
    
    if (!fs.existsSync(fullPath)) {
      return null;
    }

    if (this.fileCache.has(fullPath)) {
      return this.fileCache.get(fullPath)!;
    }

    // Evict oldest entries if cache limit reached
    if (this.fileCache.size >= this.maxFiles) {
      const firstKey = this.fileCache.keys().next().value;
      if (firstKey) {
        const fileToEvict = this.fileCache.get(firstKey);
        if (fileToEvict && this.project) {
          try {
            this.project.removeSourceFile(fileToEvict);
          } catch {
            // Ignore removal errors
          }
        }
        this.fileCache.delete(firstKey);
      }
    }

    const project = this.getProject();
    const sourceFile = project.addSourceFileAtPath(fullPath);
    this.fileCache.set(fullPath, sourceFile);
    return sourceFile;
  }

  /**
   * Clears memory cache and project references
   */
  public clear(): void {
    this.fileCache.clear();
    this.project = null;
  }
}
