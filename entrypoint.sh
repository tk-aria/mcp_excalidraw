#!/bin/sh
set -e

PORT="${PORT:-3000}"
MCP_PORT="${MCP_PORT:-3001}"

# Cleanup on exit — kill all child processes
cleanup() {
    echo "Shutting down..."
    kill $CANVAS_PID $MCP_PID 2>/dev/null || true
    wait 2>/dev/null
    exit 0
}
trap cleanup TERM INT EXIT

# Limit Node.js heap for MCP subprocess
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=256}"

# Start Canvas server (REST API + Web UI)
echo "Starting Excalidraw Canvas server on port ${PORT}..."
node dist/server.js &
CANVAS_PID=$!

# Wait for canvas to be ready
sleep 2

# Start MCP HTTP bridge via supergateway (stdio -> StreamableHTTP)
echo "Starting MCP HTTP bridge on port ${MCP_PORT}..."
EXPRESS_SERVER_URL="http://localhost:${PORT}" \
ENABLE_CANVAS_SYNC=true \
npx supergateway \
  --stdio "node dist/index.js" \
  --outputTransport streamableHttp \
  --port "${MCP_PORT}" \
  --host 0.0.0.0 \
  --healthEndpoint /health &
MCP_PID=$!

echo "Excalidraw ready: Canvas=${PORT}, MCP=${MCP_PORT}"

# Wait for either process to exit
wait $CANVAS_PID $MCP_PID
