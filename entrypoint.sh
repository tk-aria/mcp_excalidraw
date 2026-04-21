#!/bin/sh
set -e

PORT="${PORT:-3000}"
MCP_PORT="${MCP_PORT:-3001}"

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
  --host 0.0.0.0 &
MCP_PID=$!

echo "Excalidraw ready: Canvas=${PORT}, MCP=${MCP_PORT}"

# Wait for either process to exit
wait $CANVAS_PID $MCP_PID
