/* ==========================================================================
   gherkin-ai-cli - Express API & Web Server
   ========================================================================== */

import express from 'express';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { detectExistingStack } from '../core/stack-detector';
import { generateContracts } from '../generators/contracts';
import { generatePrompts } from '../generators/prompts';
import { parseGherkinText } from '../core/gherkin-parser';
import { handleQualityCommand } from '../commands/quality';
import { loadConfig, saveConfig } from '../core/config';
import { buildSpecificationIR } from '../core/ir-builder';
import { RealAgentProvider, LLMConfig } from '../core/agent-adapter';
import { exec } from 'child_process';

export function startWebServer(port: number): void {
  const app = express();
  
  // Localhost-only security check (no cors dependency required)
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
      return res.status(403).json({ success: false, error: 'Access denied: Local connections only.' });
    }
    next();
  });
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
      const specsDir = fs.existsSync(path.join(process.cwd(), 'features'))
        ? path.join(process.cwd(), 'features')
        : (fs.existsSync(path.join(process.cwd(), 'specs')) ? path.join(process.cwd(), 'specs') : path.join(process.cwd(), 'features'));
      if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });

      const featurePath = path.join(specsDir, `${safeName}.feature`);
      fs.writeFileSync(featurePath, gherkinText, 'utf8');

      // Load config & generate
      const config = detectExistingStack(process.cwd());
      // Save detected config to lock it in
      saveConfig(config);

      const parsed = parseGherkinText(gherkinText);
      const ir = buildSpecificationIR(parsed, req.body.file);
      const generatedContracts = generateContracts(parsed, ir, config);
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
      const targetDir = fs.existsSync(path.join(process.cwd(), 'features'))
        ? path.join(process.cwd(), 'features')
        : (fs.existsSync(path.join(process.cwd(), 'specs')) ? path.join(process.cwd(), 'specs') : path.join(process.cwd(), 'features'));
      if (!fs.existsSync(targetDir)) {
        return res.json({ success: true, features: [] });
      }
      
      const getFilesRecursively = (dir: string): string[] => {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        for (const file of list) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat && stat.isDirectory()) {
            results = results.concat(getFilesRecursively(filePath));
          } else {
            results.push(filePath);
          }
        }
        return results;
      };

      const allFiles = getFilesRecursively(targetDir);
      // Return relative paths so the UI just shows 'backend/customer_crud.feature'
      const files = allFiles
        .filter(f => f.endsWith('.feature'))
        .map(f => path.relative(targetDir, f).replace(/\\/g, '/'));

      res.json({ success: true, features: files });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get Feature Content (Dynamic Paths)
  app.use('/api/features', (req, res, next) => {
    // If it's the base route /api/features, skip and let the app.get('/api/features') handle it
    if (req.path === '/' || req.path === '') {
      return next();
    }
    
    try {
      const targetDir = fs.existsSync(path.join(process.cwd(), 'features'))
        ? path.join(process.cwd(), 'features')
        : path.join(process.cwd(), 'specs');
      
      // req.path will be e.g. '/backend/customer_crud.feature'
      const featureName = decodeURIComponent(req.path.replace(/^\//, ''));
      const featurePath = path.join(targetDir, featureName);
      if (!fs.existsSync(featurePath)) {
        return res.status(404).json({ success: false, error: 'Feature not found' });
      }
      const content = fs.readFileSync(featurePath, 'utf8');
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Read arbitrary file (for Explorer viewer)
  app.get('/api/file', (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) return res.status(400).json({ success: false, error: 'Path is required' });
      const fullPath = path.join(process.cwd(), filePath);
      if (!fullPath.startsWith(process.cwd())) {
         return res.status(403).json({ success: false, error: 'Access denied' });
      }
      if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, error: 'File not found' });
      const content = fs.readFileSync(fullPath, 'utf8');
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

  // API: Get Directory Tree
  app.get('/api/tree', (req, res) => {
    try {
      const buildTree = (dirPath: string, depth: number = 0): any => {
        const result: any = { name: path.basename(dirPath), type: 'dir', children: [] };
        
        // Prevent infinite recursion on deep trees
        if (depth > 10) return result;
        
        let items: string[];
        try {
          items = fs.readdirSync(dirPath);
        } catch {
          // Directory not readable (permissions, etc.)
          return result;
        }

        for (const item of items) {
          if (['node_modules', '.git', 'dist', '.cache', '.next', 'vendor', '__pycache__'].includes(item)) continue;
          if (item.startsWith('.')) continue;
          
          const fullPath = path.join(dirPath, item);
          try {
            // Use lstatSync to avoid following broken symlinks
            const stat = fs.lstatSync(fullPath);

            if (stat.isSymbolicLink()) {
              // Check if symlink target exists before following
              try {
                const realStat = fs.statSync(fullPath);
                if (realStat.isDirectory()) {
                  result.children.push(buildTree(fullPath, depth + 1));
                } else {
                  result.children.push({ name: item, type: 'file', symlink: true });
                }
              } catch {
                // Broken symlink — include it as a marker but don't crash
                result.children.push({ name: item, type: 'symlink-broken' });
              }
            } else if (stat.isDirectory()) {
              result.children.push(buildTree(fullPath, depth + 1));
            } else {
              result.children.push({ name: item, type: 'file' });
            }
          } catch {
            // Skip entries we can't stat at all (race condition, permissions, etc.)
            continue;
          }
        }
        return result;
      };
      
      const tree = buildTree(process.cwd());
      res.json({ success: true, tree });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get Inventory
  app.get('/api/inventory', (req, res) => {
    try {
      const inventoryPath = path.join(process.cwd(), '.ghe', 'inventory.json');
      if (!fs.existsSync(inventoryPath)) {
        return res.json({ success: true, inventory: [] });
      }
      const data = fs.readFileSync(inventoryPath, 'utf8');
      res.json({ success: true, inventory: JSON.parse(data) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get Agent Logs
  app.get('/api/agent-logs', (req, res) => {
    try {
      const logsPath = path.join(process.cwd(), '.ghe', 'agent_logs.json');
      if (!fs.existsSync(logsPath)) {
        return res.json({ success: true, logs: [] });
      }
      const data = fs.readFileSync(logsPath, 'utf8');
      res.json({ success: true, logs: JSON.parse(data) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get Prompts
  app.get('/api/prompts', (req, res) => {
    try {
      const promptsDir = path.join(process.cwd(), 'generated-specs', 'prompts');
      if (!fs.existsSync(promptsDir)) {
        return res.json({ success: true, prompts: [] });
      }
      const files = fs.readdirSync(promptsDir).filter(f => f.endsWith('.md'));
      
      const prompts = files.map(file => {
        const content = fs.readFileSync(path.join(promptsDir, file), 'utf8');
        return { filename: file, content };
      });
      
      res.json({ success: true, prompts });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get Contracts
  app.get('/api/contracts', (req, res) => {
    try {
      const specsDir = path.join(process.cwd(), 'generated-specs');
      if (!fs.existsSync(specsDir)) {
        return res.json({ success: true, contracts: [] });
      }
      const files = fs.readdirSync(specsDir).filter(f => !fs.statSync(path.join(specsDir, f)).isDirectory());
      
      const contracts = files.map(file => {
        const content = fs.readFileSync(path.join(specsDir, file), 'utf8');
        return { filename: file, content };
      });
      
      res.json({ success: true, contracts });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Get Governance
  app.get('/api/governance', (req, res) => {
    try {
      const govPath = path.join(process.cwd(), '.ghkgovernance.yaml');
      if (!fs.existsSync(govPath)) {
        return res.status(404).json({ success: false, error: 'Governance file not found' });
      }
      const content = fs.readFileSync(govPath, 'utf8');
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // API: Execute CLI Command
  app.post('/api/execute', (req, res) => {
    try {
      const { command } = req.body;
      if (!command || typeof command !== 'string') {
        return res.status(400).json({ success: false, error: 'Command is required and must be a string' });
      }

      // Security: Strict validation against OS command injection
      let safeCmd = command.trim();
      if (safeCmd.startsWith('ghk ')) {
        safeCmd = safeCmd.substring(4).trim();
      }

      // Regex to detect shell metacharacters: &, |, ;, $, >, <, `
      if (/[&|;$><`]/.test(safeCmd)) {
        return res.status(403).json({ success: false, error: 'Command contains illegal characters' });
      }

      // Allowed CLI root commands
      const allowedCommands = ['autopilot', 'verify', 'diff', 'generate', 'add', 'lint'];
      const baseCmd = safeCmd.split(' ')[0];
      if (!allowedCommands.includes(baseCmd)) {
        return res.status(403).json({ success: false, error: `Command '${baseCmd}' is not allowed via Web Studio RCE` });
      }
      
      const cliPath = path.resolve(__dirname, '../../dist/index.js');
      const fullCmd = `node "${cliPath}" ${safeCmd}`;

      exec(fullCmd, { cwd: process.cwd() }, (error, stdout, stderr) => {
        res.json({ 
          success: !error, 
          output: stdout || '', 
          errorOutput: stderr || '', 
          error: error ? error.message : null 
        });
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  app.listen(port, '127.0.0.1', () => {
    console.log(chalk.cyan(`\n🚀 Gherkin AI Web UI is running (Bound to 127.0.0.1)`));
    console.log(chalk.white(`Navigate to: `) + chalk.green.bold(`http://127.0.0.1:${port}`));
    console.log(chalk.gray(`Press Ctrl+C to stop the server.`));
  });
}
