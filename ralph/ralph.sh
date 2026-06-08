#!/bin/bash
# Ralph — autonomous loop to scale the haystack server to 100k visible asteroids
# (multiplayer, 5 km/s). Each iteration runs Opus 4.8 at MAX thinking/effort.
#
# Runs until every item in ralph/prd.json has passes: true, or MAX_ITERATIONS hit.
# Run from a clean worktree/branch — it commits per iteration.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RALPH_MD="$SCRIPT_DIR/RALPH.md"
PRD="$SCRIPT_DIR/prd.json"
LOG_FILE="$SCRIPT_DIR/ralph.log"
MAX_ITERATIONS="${MAX_ITERATIONS:-30}"

# Opus 4.8 at maximum reasoning budget for every unattended iteration.
export CLAUDE_CODE_EFFORT_LEVEL=max

echo "Ralph: repo=$REPO_ROOT  model=opus  effort=max  max_iterations=$MAX_ITERATIONS"
echo ""

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "==============================================================="
  echo "  Ralph — iteration $i of $MAX_ITERATIONS  $(date '+%F %T')"
  echo "==============================================================="
  if command -v jq &>/dev/null; then
    jq -r '.items[] | "  \(.id) [\(if .passes then "PASS" else "TODO" end)] \(.name)"' "$PRD"
  fi
  echo ""

  # Re-invoke Claude with the SAME instructions every iteration, from the repo root.
  # tee /dev/stderr so the operator sees live output AND we capture it for the log.
  OUTPUT=$( (cd "$REPO_ROOT" && claude --model opus --dangerously-skip-permissions --print < "$RALPH_MD") 2>&1 | tee /dev/stderr ) || true

  {
    echo "--- iteration $i $(date '+%F %T') ---"
    echo "$OUTPUT" | tail -20
    echo ""
  } >> "$LOG_FILE"

  # Robust stop: every backlog item passes (cannot be tricked by output text).
  if command -v jq &>/dev/null && jq -e '.items | all(.passes == true)' "$PRD" >/dev/null 2>&1; then
    echo "Ralph: all items pass at iteration $i."
    exit 0
  fi
  # Fast-path sentinel on the LAST line only (so quoted mid-narrative refs don't trip it).
  if [ "$(echo "$OUTPUT" | tail -n 1 | tr -d '[:space:]')" = "<promise>COMPLETE</promise>" ]; then
    echo "Ralph: COMPLETE signal at iteration $i."
    exit 0
  fi

  echo "Iteration $i complete. Continuing in 2 seconds..."
  sleep 2
done

echo "Ralph reached max iterations ($MAX_ITERATIONS). Inspect ralph/prd.json + ralph/progress.txt."
exit 1
