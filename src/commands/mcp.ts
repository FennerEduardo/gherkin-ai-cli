/* ==========================================================================
   gherkin-ai-cli - 'mcp' Command Handler (Model Context Protocol Server)
   ========================================================================== */

import { startMcpServer } from '../mcp/mcp-server';
import { installMcpConfig } from '../mcp/mcp-installer';

export async function handleMcpCommand(subcommand?: string, options: { install?: boolean } = {}): Promise<void> {
  if (subcommand === 'install' || options.install) {
    installMcpConfig();
    return;
  }
  // Stdio JSON-RPC server: stdout is reserved for protocol frames.
  await startMcpServer();
}
