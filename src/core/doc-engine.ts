import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { parseGherkinText } from './gherkin-parser';
import { buildIR } from './ir-builder';
import { SpecificationIR } from './semantic-ir';

export interface DocEngineResult {
  outputDir: string;
  filesGenerated: number;
}

export function generateLivingDocumentation(projectDir: string): DocEngineResult {
  const config = loadConfig(path.join(projectDir, 'gherkin-ai.config.json'));
  const specDir = path.resolve(projectDir, config.specDir || 'features');
  const docDir = path.resolve(projectDir, '.ghe/docs');

  if (!fs.existsSync(specDir)) {
    throw new Error(`Specification directory not found: ${specDir}`);
  }

  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }

  const features = findFeatureFiles(specDir);
  if (features.length === 0) {
    throw new Error(`No .feature files found in ${specDir}`);
  }

  const irs: SpecificationIR[] = [];

  for (const feature of features) {
    try {
      const text = fs.readFileSync(feature, 'utf8');
      const parsed = parseGherkinText(text);
      const ir = buildIR(parsed, path.relative(projectDir, feature));
      irs.push(ir);
    } catch (e: any) {
      console.warn(`Warning: Could not parse feature ${feature} - ${e.message}`);
    }
  }

  // Generate an index.md
  let indexMd = `# 📖 Gherkin AI - Living Documentation\n\n`;
  indexMd += `> Generated on ${new Date().toLocaleString()}\n\n`;
  indexMd += `## Features Overview\n\n`;
  
  indexMd += `| Feature | Scenarios | Endpoints | Domain Events |\n`;
  indexMd += `|---------|-----------|-----------|---------------|\n`;
  
  irs.forEach(ir => {
    const featureSlug = ir.featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    indexMd += `| [${ir.featureName}](./${featureSlug}.md) | ${ir.scenarios.length} | ${ir.apiEndpoints.length} | ${ir.events.length} |\n`;
    
    // Generate individual feature pages
    generateFeatureDoc(ir, path.join(docDir, `${featureSlug}.md`));
  });

  fs.writeFileSync(path.join(docDir, 'index.md'), indexMd);

  return {
    outputDir: docDir,
    filesGenerated: irs.length + 1
  };
}

function findFeatureFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findFeatureFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.feature')) {
      results.push(fullPath);
    }
  }
  return results;
}

function generateFeatureDoc(ir: SpecificationIR, outPath: string) {
  let md = `# Feature: ${ir.featureName}\n\n`;
  md += `**Source**: \`${ir.sourceFile}\`\n\n`;

  if (ir.featureDescription && ir.featureDescription.length > 0) {
    md += `## Description\n${ir.featureDescription.join('\n')}\n\n`;
  }

  md += `## 🎬 Scenarios (${ir.scenarios.length})\n\n`;
  ir.scenarios.forEach(sc => {
    md += `### ${sc.name}\n`;
    if (sc.preconditions.length > 0) {
      md += `**Preconditions:**\n${sc.preconditions.map(p => `- ${p}`).join('\n')}\n\n`;
    }
    if (sc.expectations.length > 0) {
      md += `**Expectations:**\n${sc.expectations.map(e => `- ${e}`).join('\n')}\n\n`;
    }
  });

  if (ir.commands.length > 0) {
    md += `## ⚡ Domain Commands\n\n`;
    ir.commands.forEach(c => {
      md += `- **${c.name}**\n`;
    });
    md += `\n`;
  }

  if (ir.apiEndpoints.length > 0) {
    md += `## 🌐 API Endpoints\n\n`;
    md += `| Method | Path | Responses |\n`;
    md += `|--------|------|-----------|\n`;
    ir.apiEndpoints.forEach(ep => {
      const responses = ep.httpCodes.map(c => c.code).join(', ');
      md += `| \`${ep.method}\` | \`${ep.path}\` | ${responses} |\n`;
    });
    md += `\n`;
  }

  fs.writeFileSync(outPath, md);
}
