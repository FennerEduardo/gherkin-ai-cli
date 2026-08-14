# 🔌 Model Context Protocol (MCP) Integration Guide for `gherkin-ai`

`gherkin-ai` CLI includes a native **Model Context Protocol (MCP)** JSON-RPC 2.0 stdio server (`ghk mcp`). This allows AI Agents (**Claude Desktop, Cursor, Antigravity, Windsurf, Roo Code, VS Code MCP Extensions**) to invoke `gherkin-ai` tools directly when editing `.feature` files or building architecture.

---

## 🌟 Exposed MCP Tools

When connected to `ghk mcp`, AI Agents gain direct access to the following 4 tools:

1. **`parse_gherkin`**: Parses `.feature` specification text into a domain AST (commands, queries, events, actors).
2. **`generate_contracts`**: Generates TypeScript, OpenAPI 3.0, and native language contracts (Python, PHP, Go, C#) from Gherkin text.
3. **`detect_stack`**: Auto-detects project tech stack & architecture from the workspace root directory.
4. **`validate_architecture`**: Validates Gherkin AST step coverage and layer import boundary isolation rules.

---

## 🛠️ Step-by-Step Configuration per AI Agent / IDE

### 1. Claude Desktop App

Edit your `claude_desktop_config.json`:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add `gherkin-ai` to the `mcpServers` section:

```json
{
  "mcpServers": {
    "gherkin-ai": {
      "command": "npx",
      "args": ["-y", "gherkin-ai@latest", "mcp"]
    }
  }
}
```

Restart Claude Desktop. You will see a hammer icon 🔨 indicating that `gherkin-ai` tools are active.

---

### 2. Cursor IDE

In Cursor, configure MCP tools via **Settings** or project configuration:

1. Open **Cursor Settings** (`Ctrl + ,` / `Cmd + ,`) → **Features** → **MCP Servers**.
2. Click **+ Add New MCP Server**.
3. Fill in:
   - **Name**: `gherkin-ai`
   - **Type**: `command` (stdio)
   - **Command**: `npx -y gherkin-ai@latest mcp`

Or add a `.cursor/mcp.json` file in your repository:

```json
{
  "mcpServers": {
    "gherkin-ai": {
      "command": "npx",
      "args": ["-y", "gherkin-ai@latest", "mcp"]
    }
  }
}
```

---

### 3. Antigravity / VS Code MCP Extensions

In VS Code or Antigravity with MCP extension installed:

Open `settings.json` and add:

```json
{
  "mcp.servers": {
    "gherkin-ai": {
      "command": "npx",
      "args": ["-y", "gherkin-ai@latest", "mcp"]
    }
  }
}
```

---

### 4. Windsurf IDE

Add `.windsurf/mcp.json` to your user home directory or project root:

```json
{
  "mcpServers": {
    "gherkin-ai": {
      "command": "npx",
      "args": ["-y", "gherkin-ai@latest", "mcp"]
    }
  }
}
```

---

### 5. Roo Code / Continue.dev

In `~/.continue/config.json` or Roo Code settings:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "gherkin-ai@latest", "mcp"]
        }
      }
    ]
  }
}
```

---

## 🧪 Testing the MCP Server Connection

You can manually verify that the stdio MCP server is working by running:

```bash
ghk mcp
```

Send the JSON-RPC `initialize` request via stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
```

The server will respond with:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"gherkin-ai-mcp","version":"1.5.0"}}}
```
