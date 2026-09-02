/* ==========================================================================
   gherkin-ai-cli - Express API & Web Server
   ========================================================================== */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { detectExistingStack } from '../core/stack-detector';
import { generateContracts } from '../generators/contracts';
import { generatePrompts } from '../generators/prompts';
import { parseGherkinText } from '../core/gherkin-parser';
import { loadConfig, saveConfig } from '../core/config';
import { RealAgentProvider, LLMConfig } from '../core/agent-adapter';

export function startWebServer(port: number): void {
  const app = express();
  
  app.use(cors());
  app.use(express.json());
  
  // Static files for frontend
  const publicPath = path.join(__dirname, 'public');
  if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
  }
  app.use(express.static(publicPath));

  // API: Get Stack
  app.get('/api/stack', (req, res) => {
    try {
      const config = detectExistingStack(process.cwd());
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Generate Feature
  app.post('/api/generate', (req, res) => {
    try {
      const { featureName, gherkinText } = req.body;
      
      if (!gherkinText) {
        return res.status(400).json({ success: false, error: 'Gherkin text is required.' });
      }

      // Save feature file
      const safeName = (featureName || 'feature').toLowerCase().replace(/\s+/g, '-');
      const specsDir = path.join(process.cwd(), 'specs');
      if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });
      
      const featurePath = path.join(specsDir, `${safeName}.feature`);
      fs.writeFileSync(featurePath, gherkinText, 'utf8');

      // Load config & generate
      const config = detectExistingStack(process.cwd());
      // Save detected config to lock it in
      saveConfig(config);

      const parsed = parseGherkinText(gherkinText);
      const generatedContracts = generateContracts(parsed, config);
      const generatedPrompts = generatePrompts(parsed, config);

      // Save contracts & prompts
      const outDir = path.join(process.cwd(), config.outputDir || 'generated-specs');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      const promptsDir = path.join(outDir, 'prompts');
      if (!fs.existsSync(promptsDir)) fs.mkdirSync(promptsDir, { recursive: true });

      // In real CLI, this writes to files. For UI, we write to files AND return.
      const files: Record<string, string> = {
        'contracts.ts': generatedContracts.contractsTs,
        'adr.md': generatedContracts.adrMd,
        'openapi.json': generatedContracts.openApiJson,
        'asyncapi.json': generatedContracts.asyncApiJson,
        ...generatedPrompts
      };

      if (generatedContracts.nativeContract) {
        files[generatedContracts.nativeContract.filename] = generatedContracts.nativeContract.content;
      }

      for (const [filename, content] of Object.entries(files)) {
        if (filename.endsWith('.md') && filename.includes('agent')) {
          fs.writeFileSync(path.join(promptsDir, filename), content, 'utf8');
        } else {
          fs.writeFileSync(path.join(outDir, filename), content, 'utf8');
        }
      }

      res.json({ success: true, message: 'Files generated successfully', files, featurePath, outDir });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: List Features
  app.get('/api/features', (req, res) => {
    try {
      const specsDir = path.join(process.cwd(), 'specs');
      if (!fs.existsSync(specsDir)) {
        return res.json({ success: true, features: [] });
      }
      const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.feature'));
      res.json({ success: true, features: files });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get Feature Content
  app.get('/api/features/:name', (req, res) => {
    try {
      const featurePath = path.join(process.cwd(), 'specs', req.params.name);
      if (!fs.existsSync(featurePath)) {
        return res.status(404).json({ success: false, error: 'Feature not found' });
      }
      const content = fs.readFileSync(featurePath, 'utf8');
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get LLM Suggestion
  app.post('/api/suggest', async (req, res) => {
    try {
      const { prompt, context } = req.body;
      const config: LLMConfig = {
        provider: (process.env.LLM_PROVIDER as any) || 'ide_delegate',
        model: process.env.LLM_MODEL,
        apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY,
        baseUrl: process.env.LLM_BASE_URL
      };
      
      const agent = new RealAgentProvider(config);
      const result = await agent.executeTask({
        id: 'ui-suggest',
        type: 'spec_generation',
        prompt,
        contextFiles: context ? [context] : []
      });
      
      res.json({ success: true, suggestion: result.agentResponse });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  app.listen(port, () => {
    console.log(chalk.cyan(`\n🚀 Gherkin AI Web UI is running!`));
    console.log(chalk.white(`Navigate to: `) + chalk.green.bold(`http://localhost:${port}`));
    console.log(chalk.gray(`Press Ctrl+C to stop the server.`));
  });
}
