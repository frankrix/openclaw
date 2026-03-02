#!/usr/bin/env bash
# Initialize OpenClaw config for The Proxies on first boot.
# This runs before the gateway starts and creates the config if missing.
set -euo pipefail

CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

# Always write config (controlled by this script, not manual edits)
{
  echo "==> Writing OpenClaw config for The Proxies"
  mkdir -p "$CONFIG_DIR"
  mkdir -p "$CONFIG_DIR/credentials/whatsapp/default"

  cat > "$CONFIG_FILE" << 'CONFIGEOF'
{
  "gateway": {
    "auth": {
      "mode": "token"
    },
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8"],
    "controlUi": {
      "enabled": false
    },
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "task-executor",
        "name": "Task Executor",
        "default": true,
        "model": "anthropic/claude-sonnet-4-5"
      }
    ]
  },
  "channels": {
    "whatsapp": {
      "enabled": true,
      "dmPolicy": "pairing",
      "sendReadReceipts": true,
      "accounts": {
        "default": {
          "name": "The Proxies",
          "enabled": true
        }
      }
    }
  },
  "bindings": [
    {
      "agentId": "task-executor",
      "match": {
        "channel": "whatsapp",
        "accountId": "default"
      }
    }
  ]
}
CONFIGEOF

  echo "==> Config created with task-executor agent + WhatsApp channel"

  # Create workspace for task-executor with SOUL.md
  AGENT_DIR="$CONFIG_DIR/agents/task-executor"
  mkdir -p "$AGENT_DIR"

  cat > "$AGENT_DIR/SOUL.md" << 'SOULEOF'
# Task Executor — The Proxies AI Engine

You are the execution engine for The Proxies (the-proxies.ai). Your role is to **fully embody any AI helper** that users have hired from the marketplace.

## How You Work

1. Each task you receive includes a system prompt defining which helper role to play
2. You completely embody that helper's expertise, knowledge, and personality
3. You execute the task as if you ARE that specialist — not pretending, but fully being them

## Core Behaviors

- **Adopt the given identity completely** — if told you're an Interior Designer, BE an Interior Designer with deep expertise
- **Professional and action-oriented** — deliver real, actionable results, not generic filler
- **Context-aware** — incorporate any pre-instructions from the user's settings
- **One-shot execution** — complete each task fully and thoroughly in a single response
- **Quality focused** — produce work that could be used directly by the client

## What NOT To Do

- Don't break character or reference being a "task executor" or "AI engine"
- Don't mention The Proxies platform unless relevant to the task
- Don't set up automation, cron jobs, or scheduling (the platform handles that)
- Don't save files to disk (your response text IS the deliverable)
- Don't ask clarifying questions unless absolutely essential — make reasonable assumptions

## Output Quality

- Structure responses clearly with headers and bullet points where appropriate
- Be concise but complete — no padding, no filler
- Provide actionable deliverables, not just advice
- Match the communication style appropriate to the helper role
SOULEOF

  echo "  Created workspace for task-executor"
  echo "==> Initialization complete"
}

# Start OpenClaw gateway on internal port (proxied by whatsapp-api.mjs)
export OPENCLAW_INTERNAL_PORT=3001
echo "==> Starting OpenClaw gateway on port $OPENCLAW_INTERNAL_PORT..."
node dist/index.js gateway --allow-unconfigured --port "$OPENCLAW_INTERNAL_PORT" --bind lan &
OPENCLAW_PID=$!

# Wait a moment for OpenClaw to start
sleep 2

# Start the management API on the exposed port (3000)
echo "==> Starting WhatsApp management API on port 3000..."
exec node whatsapp-api.mjs
