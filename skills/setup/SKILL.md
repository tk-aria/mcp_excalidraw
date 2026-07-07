---
name: setup
description: Set up and verify the Excalidraw canvas server connection. Use when the user asks to start excalidraw, set up the canvas, or when MCP tools fail to connect.
user-invocable: true
allowed-tools:
  - Bash(curl *)
  - Bash(npm *)
  - Bash(node *)
  - Read
---

# /excalidraw:setup — Canvas Server Setup

Check the Excalidraw canvas server status and help the user start it if needed.

Arguments passed: `$ARGUMENTS`

## Steps

### 1. Check server status

Test if the canvas server is reachable:

```bash
curl -s -o /dev/null -w "%{http_code}" ${EXCALIDRAW_URL:-http://localhost:3000}/api/elements
```

If it returns 200, the server is running. Report the URL and element count.

### 2. If not running

Tell the user:

> The Excalidraw canvas server is not reachable at `${EXCALIDRAW_URL:-http://localhost:3000}`.
>
> To start it:
> ```bash
> cd /path/to/mcp_excalidraw
> npm run build
> PORT=3000 npm run canvas
> ```
> Then open `http://localhost:3000` in a browser to see the canvas.
>
> Set `EXCALIDRAW_URL` environment variable if the server runs on a different host/port.

### 3. Verify MCP endpoint

```bash
curl -s -X POST ${EXCALIDRAW_URL:-http://localhost:3000}/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}},"id":1}'
```

If this returns a valid JSON-RPC response, the MCP Streamable HTTP endpoint is working.
