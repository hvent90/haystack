#!/usr/bin/env bash
#
# Bring up the Haystack dev stack and expose it publicly through the mars-dev
# Cloudflare tunnel at https://top-pringles-fan.smartypants.dev
#
# Launches three processes in a single new tmux window, one per pane:
#   1. API server      (bun src/server/main.ts, :8787)
#   2. Vite client     (:5273 — the port the mars-dev tunnel ingress points at)
#   3. cloudflared tunnel run mars-dev
#
# The tunnel route (top-pringles-fan.smartypants.dev -> localhost:5273) is defined
# in ~/.cloudflared/config.yml. Run our client on that port so the route lands here.
#
# Usage: bun run dev:public   (or: bash scripts/dev-public.sh)
set -euo pipefail

SESSION="${HAYSTACK_TMUX_SESSION:-haystack}"
WINDOW="${HAYSTACK_TMUX_WINDOW:-public}"
CLIENT_PORT="${HAYSTACK_CLIENT_PORT:-5273}"
TUNNEL="${HAYSTACK_TUNNEL:-mars-dev}"
PUBLIC_URL="${HAYSTACK_PUBLIC_URL:-https://top-pringles-fan.smartypants.dev}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is not installed" >&2
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "error: cloudflared is not installed" >&2
  exit 1
fi

# Per-pane commands. `exec` so each pane runs as its single process and the pane
# closes (rather than dropping to an idle shell) if that process exits.
server_cmd="exec bun src/server/main.ts"
client_cmd="exec bunx vite --host 0.0.0.0 --port $CLIENT_PORT --strictPort"
tunnel_cmd="exec cloudflared tunnel run $TUNNEL"

# Create the window in $ROOT. If already inside tmux, add it to the current
# session; otherwise create/reuse a detached session named $SESSION.
if [ -n "${TMUX:-}" ]; then
  win="$(tmux new-window -P -F '#{window_id}' -n "$WINDOW" -c "$ROOT")"
else
  tmux has-session -t "$SESSION" 2>/dev/null || tmux new-session -d -s "$SESSION" -c "$ROOT" -n scratch
  win="$(tmux new-window -P -F '#{window_id}' -t "$SESSION" -n "$WINDOW" -c "$ROOT")"
fi

# Run server in the window's initial pane, then split for client and tunnel.
# send-keys runs each command in the active pane's shell (avoids nested-quote
# pitfalls); split-window -P returns the new pane id so we target it explicitly.
# No select-layout: if gmux (or any sidebar plugin) is present its after-new-window
# hook adds its own pane and pins width — let it manage layout rather than fight it.
tmux send-keys -t "$win" "$server_cmd" C-m
client_pane="$(tmux split-window -h -P -F '#{pane_id}' -t "$win" -c "$ROOT")"
tmux send-keys -t "$client_pane" "$client_cmd" C-m
tunnel_pane="$(tmux split-window -v -P -F '#{pane_id}' -t "$client_pane" -c "$ROOT")"
tmux send-keys -t "$tunnel_pane" "$tunnel_cmd" C-m

echo "Haystack public dev stack starting in tmux window '$WINDOW':"
echo "  - server  http://127.0.0.1:8787"
echo "  - client  http://127.0.0.1:$CLIENT_PORT  (tunnel target)"
echo "  - tunnel  cloudflared run $TUNNEL"
echo "  - public  $PUBLIC_URL"
if [ -n "${TMUX:-}" ]; then
  tmux select-window -t "$win"
else
  echo "Attach with: tmux attach -t $SESSION   (then select the '$WINDOW' window)"
fi
