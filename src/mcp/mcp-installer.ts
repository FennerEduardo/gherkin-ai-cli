/* ==========================================================================
   gherkin-ai-cli - MCP Auto-Installer for Cursor & Claude Desktop
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

export interface McpInstallOptions {
  global?: boolean;
  project?: boolean;
}

export function installMcpConfig(options: McpInstallOptions = { global: true, project: true }): void {
  console.log(chalk.bold.cyan('\n🔌 Installing gherkin-ai MCP Server Config...\n'));

  const mcpConfigEntry = {
    command: 'npx',
    args: ['-y', 'gherkin-ai', 'mcp']
  };

  let installedCount = 0;

  // 1. Local project .cursor/mcp.json
  if (options.project) {
    const localCursorDir = path.join(process.cwd(), '.cursor');
    const localCursorFile = path.join(localCursorDir, 'mcp.json');

    try {
      if (!fs.existsSync(localCursorDir)) {
        fs.mkdirSync(localCursorDir, { recursive: true });
      }
      let cursorJson: any = { mcpServers: {} };
      if (fs.existsSync(localCursorFile)) {
        const raw = fs.readFileSync(localCursorFile, 'utf8');
        cursorJson = JSON.parse(raw);
        if (!cursorJson.mcpServers) cursorJson.mcpServers = {};
      }
      cursorJson.mcpServers['gherkin-ai'] = mcpConfigEntry;
      fs.writeFileSync(localCursorFile, JSON.stringify(cursorJson, null, 2), 'utf8');
      console.log(chalk.green(`  ✔ Updated local Cursor config: ${localCursorFile}`));
      installedCount++;
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Could not write local .cursor/mcp.json: ${(err as Error).message}`));
    }
  }

  // 2. Global Claude Desktop config
  if (options.global) {
    const home = os.homedir();
    const platform = os.platform();
    let claudeConfigPath = '';

    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      claudeConfigPath = path.join(appData, 'Claude', 'claude_desktop_config.json');
    } else if (platform === 'darwin') {
      claudeConfigPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    } else {
      claudeConfigPath = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    }

    try {
      const claudeDir = path.dirname(claudeConfigPath);
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      let claudeJson: any = { mcpServers: {} };
      if (fs.existsSync(claudeConfigPath)) {
        const raw = fs.readFileSync(claudeConfigPath, 'utf8');
        claudeJson = JSON.parse(raw);
        if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
      }
      claudeJson.mcpServers['gherkin-ai'] = mcpConfigEntry;
      fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeJson, null, 2), 'utf8');
      console.log(chalk.green(`  ✔ Updated Claude Desktop config: ${claudeConfigPath}`));
      installedCount++;
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Could not write Claude Desktop config: ${(err as Error).message}`));
    }
  }

  if (installedCount > 0) {
    console.log(chalk.bold.green('\n🎉 MCP server installation complete! Restart Cursor/Claude to take effect.\n'));
  } else {
    console.log(chalk.red('\n✖ Installation failed. Check write permissions.\n'));
  }
}
