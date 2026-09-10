#!/usr/bin/env bash
# Runs the opencode agent in headless JSON mode inside the workspace.
# Expects MODEL and TASK to be passed in via the environment.
set -euo pipefail

export HOME=/home/agent

if [[ -z "${MODEL:-}" ]]; then
  echo '{"type":"system","part":{"type":"error","text":"MODEL env var is required"}}'
  exit 1
fi
if [[ -z "${TASK:-}" ]]; then
  echo '{"type":"system","part":{"type":"error","text":"TASK env var is required"}}'
  exit 1
fi

cd "${WORKDIR:-/workspace}" 2>/dev/null || cd /workspace

echo "{\"type\":\"system\",\"part\":{\"type\":\"info\",\"text\":\"Aurex agent starting on model $MODEL in $(pwd)\"}}" >&2

# --auto: auto-approve permissions (safe: isolated container)
# --format json: emit structured NDJSON events on stdout
exec opencode run --format json --auto --model "$MODEL" "$TASK"
