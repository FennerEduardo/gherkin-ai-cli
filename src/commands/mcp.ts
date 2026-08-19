/* ==========================================================================
   gherkin-ai-cli - 'mcp' Command Handler (Model Context Protocol Server)
   ========================================================================== */

import { startMcpServer } from '../mcp/mcp-server';
import { installMcpConfig } from '../mcp/mcp-installer';

export async function handleMcpCommand(subcommand?: string): Promise<void> {
  if (subcommand === 'install' || process.argv.includes('--install')) {
    installMcpConfig();
    return;
  }
  // Silent start for stdio MCP JSON-RPC 2.0 protocol
  startMcpServer();
}

