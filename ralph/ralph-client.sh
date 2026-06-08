#!/bin/bash
# Ralph (client-render) — autonomous Claude Code loop
# Renders 100k+ asteroids client-side, frustum-culled, zero server impact.
# Runs until every item in prd-client.json has passes: true (or MAX_ITERATIONS).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RALPH_MD="$SCRIPT_DIR/RALPH-CLIENT.md"
PRD="$SCRIPT_DIR/prd-client.json"
MAX_ITERATIONS=30
LOG_FILE="$SCRIPT_DIR/ralph-client.log"

echo "Starting Ralph (client-render) loop..."
echo "Worktree: $SCRIPT_DIR"
echo "Max iterations: $MAX_ITERATIONS"
echo ""

for i in $(seq 1 $MAX_ITERATIONS); do
  echo "==============================================================="
  echo "  Ralph (client) — Iteration $i of $MAX_ITERATIONS  $(date '+%F %T')"
  echo "==============================================================="

  if command -v jq &>/dev/null; then
    jq -r '.items[] | "  \(.id) [\(if .passes then "PASS" else "TODO" end)] \(.name)"' "$PRD"
  fi
  echo ""

  # Re-invoke Claude with the SAME instructions every time.
  OUTPUT=$(cd "$SCRIPT_DIR/.." && claude --dangerously-skip-permissions --print < "$RALPH_MD" 2>&1 | tee /dev/stderr) || true

  {
    echo "--- Iteration $i $(date '+%F %T') ---"
    echo "$OUTPUT" | tail -25
    echo ""
  } >> "$LOG_FILE"

  # Robust stop: re-validate against prd-client.json itself (can't be tricked by output text).
  if command -v jq &>/dev/null && jq -e '.items | all(.passes == true)' "$PRD" >/dev/null 2>&1; then
    echo "Ralph (client) completed all items at iteration $i (verified via prd-client.json)."
    exit 0
  fi

  # Fast-path secondary: sentinel on the LAST line only.
  if [ "$(echo "$OUTPUT" | tail -n 1 | tr -d '[:space:]')" = "<promise>CLIENT-COMPLETE</promise>" ]; then
    echo "Ralph (client) emitted the COMPLETE signal at iteration $i."
    exit 0
  fi

  echo "Iteration $i complete. Continuing in 2 seconds..."
  sleep 2
done

echo "Ralph (client) reached max iterations ($MAX_ITERATIONS). Inspect prd-client.json + progress-client.txt."
exit 1
