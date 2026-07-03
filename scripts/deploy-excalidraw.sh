#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${EXCALIDRAW_REPO:-https://github.com/yctimlin/mcp_excalidraw.git}"
DEPLOY_DIR="${EXCALIDRAW_DEPLOY_DIR:-${HOME}/mcp_excalidraw}"
COMPOSE_SERVICE="canvas"
PORT="${EXCALIDRAW_PORT:-3000}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Deploy Excalidraw canvas server using the current docker context.

Options:
  -d, --dir DIR         Deploy directory (default: ~/mcp_excalidraw)
  -p, --port PORT       Host port to expose (default: 3000)
  -c, --context CTX     Docker context to use (default: current)
      --mcp-scope SCOPE Configure .mcp.json after deploy (local|project|user, default: project)
      --no-mcp          Skip .mcp.json configuration
      --status          Show running container status and exit
      --stop            Stop the running container and exit
      --mcp-url         Print the MCP endpoint URL and exit
  -h, --help            Show this help

MCP scope:
  local    — .mcp.json in current working directory
  project  — .mcp.json in the git project root (default)
  user     — ~/.claude.json (global)

Environment:
  EXCALIDRAW_REPO        Git repo URL (default: yctimlin/mcp_excalidraw)
  EXCALIDRAW_DEPLOY_DIR  Deploy directory override
  EXCALIDRAW_PORT        Host port override
EOF
  exit 0
}

DOCKER_CONTEXT=""
ACTION="deploy"
MCP_SCOPE="project"
SKIP_MCP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)       DEPLOY_DIR="$2"; shift 2 ;;
    -p|--port)      PORT="$2"; shift 2 ;;
    -c|--context)   DOCKER_CONTEXT="$2"; shift 2 ;;
    --mcp-scope)    MCP_SCOPE="$2"; shift 2 ;;
    --no-mcp)       SKIP_MCP=true; shift ;;
    --status)       ACTION="status"; shift ;;
    --stop)         ACTION="stop"; shift ;;
    --mcp-url)      ACTION="mcp-url"; shift ;;
    -h|--help)      usage ;;
    *)              echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -n "$DOCKER_CONTEXT" ]]; then
  export DOCKER_CONTEXT
fi

resolve_host() {
  local endpoint
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || echo "")

  if [[ "$endpoint" == ssh://* ]]; then
    local ssh_target="${endpoint#ssh://}"
    ssh -G "$ssh_target" 2>/dev/null | awk '/^hostname / {print $2}' || echo "$ssh_target"
  else
    echo "localhost"
  fi
}

print_mcp_url() {
  local host
  host=$(resolve_host)
  echo "http://${host}:${PORT}/mcp"
}

resolve_mcp_target() {
  case "$MCP_SCOPE" in
    local)
      echo "${PWD}/.mcp.json"
      ;;
    project)
      local root
      root=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
      echo "${root}/.mcp.json"
      ;;
    user)
      echo "${HOME}/.claude.json"
      ;;
    *)
      echo "Error: invalid --mcp-scope '${MCP_SCOPE}' (local|project|user)" >&2
      return 1
      ;;
  esac
}

configure_mcp() {
  local mcp_url="$1"
  local target
  target=$(resolve_mcp_target) || return 1

  echo "==> Configuring MCP in ${target} (scope: ${MCP_SCOPE})"

  if [[ "$MCP_SCOPE" == "user" ]]; then
    # ~/.claude.json has a different structure: top-level mcpServers
    if [[ -f "$target" ]]; then
      local updated
      updated=$(python3 -c "
import json, sys
with open('$target') as f:
    cfg = json.load(f)
cfg.setdefault('mcpServers', {})
cfg['mcpServers']['excalidraw'] = {'type': 'streamable-http', 'url': '$mcp_url'}
json.dump(cfg, sys.stdout, indent=2, ensure_ascii=False)
print()
") || { echo "Error: failed to update ${target}" >&2; return 1; }
      echo "$updated" > "$target"
    else
      python3 -c "
import json, sys
json.dump({'mcpServers': {'excalidraw': {'type': 'streamable-http', 'url': '$mcp_url'}}}, sys.stdout, indent=2)
print()
" > "$target"
    fi
  else
    # .mcp.json format: { "mcpServers": { ... } }
    if [[ -f "$target" ]]; then
      local updated
      updated=$(python3 -c "
import json, sys
with open('$target') as f:
    cfg = json.load(f)
cfg.setdefault('mcpServers', {})
cfg['mcpServers']['excalidraw'] = {'type': 'streamable-http', 'url': '$mcp_url'}
json.dump(cfg, sys.stdout, indent=2, ensure_ascii=False)
print()
") || { echo "Error: failed to update ${target}" >&2; return 1; }
      echo "$updated" > "$target"
    else
      python3 -c "
import json, sys
json.dump({'mcpServers': {'excalidraw': {'type': 'streamable-http', 'url': '$mcp_url'}}}, sys.stdout, indent=2)
print()
" > "$target"
    fi
  fi

  echo "    excalidraw -> ${mcp_url}"
}

case "$ACTION" in
  mcp-url)
    print_mcp_url
    exit 0
    ;;

  status)
    docker compose -f "${DEPLOY_DIR}/docker-compose.yml" ps 2>/dev/null || echo "Not deployed"
    exit 0
    ;;

  stop)
    docker compose -f "${DEPLOY_DIR}/docker-compose.yml" down
    exit 0
    ;;
esac

# --- Deploy ---

echo "==> Docker context: $(docker context inspect --format '{{.Name}}' 2>/dev/null || echo 'default')"
echo "==> Deploy dir: ${DEPLOY_DIR}"
echo "==> Port: ${PORT}"

if [[ -d "${DEPLOY_DIR}/.git" ]]; then
  echo "==> Updating existing repo..."
  git -C "${DEPLOY_DIR}" pull --ff-only
else
  echo "==> Cloning repo..."
  git clone "${REPO_URL}" "${DEPLOY_DIR}"
fi

echo "==> Building and starting canvas server..."
PORT="${PORT}" docker compose -f "${DEPLOY_DIR}/docker-compose.yml" up "${COMPOSE_SERVICE}" -d --build

echo "==> Waiting for health check..."
local_timeout=60
elapsed=0
while [[ $elapsed -lt $local_timeout ]]; do
  if docker compose -f "${DEPLOY_DIR}/docker-compose.yml" ps "${COMPOSE_SERVICE}" --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

if [[ $elapsed -ge $local_timeout ]]; then
  echo "WARNING: Health check did not pass within ${local_timeout}s"
  docker compose -f "${DEPLOY_DIR}/docker-compose.yml" logs "${COMPOSE_SERVICE}" --tail 20
  exit 1
fi

MCP_URL=$(print_mcp_url)
echo ""
echo "==> Deployed successfully!"
echo "    Canvas: http://$(resolve_host):${PORT}/"
echo "    MCP:    ${MCP_URL}"

if [[ "$SKIP_MCP" != "true" ]]; then
  echo ""
  configure_mcp "$MCP_URL"
else
  echo ""
  echo "To configure Claude Code manually:"
  echo "    claude mcp add --transport streamable-http -s project excalidraw ${MCP_URL}"
fi
