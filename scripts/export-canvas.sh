#!/usr/bin/env bash
# export-canvas.sh — Excalidraw canvasからSVG/PNGをエクスポートし、
# SVGから構造化JSONデータを抽出するスクリプト
#
# Usage:
#   ./scripts/export-canvas.sh [OPTIONS]
#
# Options:
#   --server URL    Excalidraw server URL (default: http://localhost:3000)
#   --format FMT    Export format: svg, png, both (default: both)
#   --output DIR    Output directory (default: ./export-output)
#   --json-only     Skip raw SVG/PNG, output parsed JSON only
#   --help          Show this help

set -euo pipefail

SERVER_URL="${EXCALIDRAW_SERVER_URL:-http://localhost:3000}"
FORMAT="both"
OUTPUT_DIR="./export-output"
JSON_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)   SERVER_URL="$2"; shift 2 ;;
    --format)   FORMAT="$2"; shift 2 ;;
    --output)   OUTPUT_DIR="$2"; shift 2 ;;
    --json-only) JSON_ONLY=true; shift ;;
    --help)
      head -12 "$0" | tail -10
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Health check
if ! curl -sf "$SERVER_URL/health" > /dev/null 2>&1; then
  echo "Error: Server $SERVER_URL is not responding" >&2
  exit 1
fi

export_svg() {
  local svg_file="$OUTPUT_DIR/canvas_${TIMESTAMP}.svg"
  local json_file="$OUTPUT_DIR/canvas_${TIMESTAMP}_parsed.json"

  echo "Exporting SVG from $SERVER_URL ..." >&2

  local response
  response=$(curl -sf -X POST "$SERVER_URL/api/export/image" \
    -H 'Content-Type: application/json' \
    -d '{"format":"svg"}' 2>/dev/null) || {
    echo "Error: SVG export request failed" >&2
    return 1
  }

  # Extract SVG data and save
  python3 -c "
import sys, json
d = json.loads('''$( echo "$response" | python3 -c "import sys; print(sys.stdin.read().replace(\"'''\", \"\\\\'\\'\\\\'\"))" )''')
if not d.get('success') or not d.get('data'):
    print('Error: Export returned no data', file=sys.stderr)
    sys.exit(1)
print(d['data'])
" > "$svg_file" 2>/dev/null || {
    # Fallback: pipe response directly
    echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('success') or not d.get('data'):
    print('Error: Export returned no data', file=sys.stderr)
    sys.exit(1)
print(d['data'])
" > "$svg_file"
  }

  if [[ "$JSON_ONLY" == "true" ]]; then
    rm -f "$svg_file"
  else
    echo "SVG saved: $svg_file" >&2
  fi

  # Parse SVG to JSON
  python3 "$(dirname "$0")/parse-svg.py" < "$svg_file" > "$json_file" 2>/dev/null || \
  python3 "$(dirname "$0")/parse-svg.py" "$svg_file" > "$json_file"

  echo "JSON saved: $json_file" >&2
  cat "$json_file"
}

export_png() {
  local png_file="$OUTPUT_DIR/canvas_${TIMESTAMP}.png"

  echo "Exporting PNG from $SERVER_URL ..." >&2

  curl -sf -X POST "$SERVER_URL/api/export/image" \
    -H 'Content-Type: application/json' \
    -d '{"format":"png"}' | python3 -c "
import sys, json, base64
d = json.load(sys.stdin)
if not d.get('success') or not d.get('data'):
    print('Error: PNG export returned no data', file=sys.stderr)
    sys.exit(1)
sys.stdout.buffer.write(base64.b64decode(d['data']))
" > "$png_file"

  echo "PNG saved: $png_file ($(wc -c < "$png_file" | tr -d ' ') bytes)" >&2
}

case "$FORMAT" in
  svg)  export_svg ;;
  png)  export_png ;;
  both)
    export_svg
    export_png
    ;;
  *)
    echo "Error: Unknown format '$FORMAT'. Use svg, png, or both." >&2
    exit 1
    ;;
esac
