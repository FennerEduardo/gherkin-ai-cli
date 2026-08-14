/* ==========================================================================
   gherkin-ai-cli - 'mcp' Command Handler (Model Context Protocol Server)
   ========================================================================== */

import { startMcpServer } from '../mcp/mcp-server';

export async function handleMcpCommand(): Promise<void> {
  // Silent start for stdio MCP JSON-RPC 2.0 protocol
  startMcpServer();
}
