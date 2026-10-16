# AI Agent Adapters & Configuration Guide

`agent-fuel` aggregates quota and token usage across different AI coding CLI assistants into a single unified dashboard. This document details each supported adapter, how it extracts quota metrics, authentication requirements, and configuration examples.

---

## Supported Providers & Adapters

| Provider | Tool Type | CLI Command | Primary Extraction Engine | Fallback Engine | Reset Cycle |
|---|---|---|---|---|---|
| **Claude Code** | `claude` | `claude` | Headless tmux TUI scrape (`/cost`) | Local state / ccusage | 5-Hour Rolling & Weekly |
| **Codex CLI** | `codex` | `codex` | Headless tmux TUI scrape (`/status`) | `ccusage` / Local budget | Weekly |
| **Cursor Agent** | `cursor` | `cursor-agent` | Connect-RPC Dashboard API (`https://api2.cursor.sh`) | Headless tmux TUI scrape (`/usage`) | Weekly |
| **Google Antigravity** | `agy` | `agy` | Headless tmux TUI scrape (status pane) | Cache | 5-Hour (Gemini) & Weekly (Claude/GPT) |
| **Grok Build** | `grok` | `grok` | Headless tmux TUI scrape (`/usage`) | Local session limits | Rolling Window |

---

## 1. Cursor Agent Adapter (`cursor`)

### Architecture & Extraction Flow

The Cursor Agent adapter (`src/adapters/cursor.ts`) uses a resilient **dual-engine** strategy:

```text
┌────────────────────────────────────────────────────────┐
│               CursorQuotaAdapter.fetchSnapshots()       │
└───────────────────────────┬────────────────────────────┘
                            │
               [Check 5m disk cache valid?]
                 ├── Yes ──> Return cached snapshot
                 └── No
                            │
              [Resolve Access Token / API Key]
         (macOS Keychain -> env CURSOR_API_KEY / CURSOR_ACCESS_TOKEN)
                 │                                │
             Token found                    No token found
                 │                                │
                 ▼                                ▼
     ┌───────────────────────┐        ┌───────────────────────┐
     │  Connect-RPC Web API  │        │   Headless tmux TUI   │
     │   GetCurrentPeriod    │        │  Run `cursor-agent`   │
     │      (~50ms HTTP)     │        │   Auto-accept prompts │
     └───────────┬───────────┘        │     Send `/usage`     │
                 │ Success            └───────────┬───────────┘
                 │                                │ Parsed screen
                 ▼                                ▼
     ┌────────────────────────────────────────────────────────┐
     │ Save snapshot to ~/.config/agent-fuel/cursor-quota-*.json│
     └────────────────────────────────────────────────────────┘
```

1. **Cache Layer**: Quota snapshots are saved to `~/.config/agent-fuel/cursor-quota-<hash>.json` with restrictive `0o600` permissions. Cache hits return immediately if younger than 5 minutes.
2. **Direct Connect-RPC API Engine (`source: 'provider-api'`)**:
   - Queries `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` with connect-protocol headers.
   - Evaluates `planUsage.totalPercentUsed` to compute remaining quota.
   - Parses `billingCycleEnd` into a human-readable reset date (e.g. `Oct 23`).
3. **Headless TUI Fallback Engine (`source: 'official-cli'`)**:
   - Spawns `cursor-agent` inside a virtual tmux terminal (200x50).
   - Automatically handles initial workspace interactive dialogs (*"Trust this folder"*, *"Update available"*).
   - Dispatches `/usage` command to trigger the usage overlay and scrapes percentage and reset date.

### Token Discovery & Authentication

The adapter looks for credentials in the following order:
1. `account.env.CURSOR_API_KEY` or `account.env.CURSOR_ACCESS_TOKEN` defined in config.
2. `process.env.CURSOR_API_KEY` or `process.env.CURSOR_ACCESS_TOKEN`.
3. macOS Keychain generic password:
   ```bash
   security find-generic-password -s "cursor-access-token" -a "cursor-user" -w
   ```

### Configuration Examples

#### Adding via CLI

Standard Cursor account:
```bash
agent-fuel config add-account cursor --type cursor --name "Cursor Agent"
```

Secondary / Work Cursor account with custom token:
```bash
agent-fuel config add-account cursor-work \
  --type cursor \
  --name "Cursor Work" \
  --cmd cursor-agent \
  --env CURSOR_API_KEY="key-..." \
  --weight 25
```

#### JSON Configuration (`~/.config/agent-fuel/config.json`)

```json
{
  "accounts": [
    {
      "id": "cursor",
      "displayName": "Cursor Agent",
      "type": "cursor",
      "command": "cursor-agent",
      "weight": 20
    },
    {
      "id": "cursor-work",
      "displayName": "Cursor Work",
      "type": "cursor",
      "command": "cursor-agent",
      "env": {
        "CURSOR_API_KEY": "cursor-enterprise-key-..."
      },
      "weight": 25
    }
  ],
  "showTotal": true
}
```

---

## 2. Claude Code Adapter (`claude`)

### Extraction Flow
Spawns `claude` inside headless tmux, handles auto-update or interactive bypasses, and sends `/cost` to read 5-hour rolling session and weekly quota limits.

### Configuration Example

```bash
# Personal profile
agent-fuel config add-account claude-personal \
  --type claude \
  --name "Claude Personal" \
  --env CLAUDE_CONFIG_DIR=~/.claude-personal \
  --weight 20
```

---

## 3. Codex CLI Adapter (`codex`)

### Extraction Flow
Spawns `codex` inside headless tmux, navigates past startup messages, runs `/status`, and extracts remaining percentage and weekly reset times. Falls back to local cost metrics if no limit warnings are triggered.

### Configuration Example

```bash
agent-fuel config add-account codex-work \
  --type codex \
  --name "Codex Work" \
  --cmd codex-work \
  --weight 20
```

---

## 4. Google Antigravity Adapter (`agy`)

### Extraction Flow
Spawns `agy`, inspects the status line breakdown, and splits usage into separate snapshots:
- **AGY ╭ Flash & Pro**: Tracks core Google Gemini models (Gemini Flash & Gemini Pro) sharing the standard 5-hour and weekly pool.
- **AGY │ Argon**: Tracks dedicated Gemini 4 Argon weekly quotas and specialized blocks.
- **AGY ╰ Other**: Tracks Claude and GPT model quotas and weekly constraints.

### Configuration Example

```bash
agent-fuel config add-account agy \
  --type agy \
  --name "AGY" \
  --command "agy" \
  --weight 20
```

---

## 5. Grok Build Adapter (`grok`)

### Extraction Flow
Spawns `grok` inside headless tmux, queries `/usage` or `/cost`, and parses credit utilization against rolling window limits. Supports custom `GROK_HOME` and `XAI_API_KEY` environments.

### Configuration Example

```bash
agent-fuel config add-account grok-work \
  --type grok \
  --name "Grok Work" \
  --env GROK_HOME=~/.grok-work \
  --env XAI_API_KEY="xai-..." \
  --weight 20
```

---

## Full Multi-Agent Configuration Example

Below is a complete `~/.config/agent-fuel/config.json` demonstrating all 5 supported agent types running concurrently:

```json
{
  "accounts": [
    {
      "id": "claude-code",
      "displayName": "Claude Code",
      "type": "claude",
      "command": "claude",
      "weight": 20
    },
    {
      "id": "claude-personal",
      "displayName": "Claude Personal",
      "type": "claude",
      "command": "claude",
      "env": {
        "CLAUDE_CONFIG_DIR": "~/.claude-personal"
      },
      "weight": 15
    },
    {
      "id": "codex",
      "displayName": "Codex",
      "type": "codex",
      "command": "codex",
      "weight": 20
    },
    {
      "id": "cursor",
      "displayName": "Cursor Agent",
      "type": "cursor",
      "command": "cursor-agent",
      "weight": 20
    },
    {
      "id": "agy",
      "displayName": "AGY",
      "type": "agy",
      "command": "agy",
      "weight": 20
    },
    {
      "id": "grok",
      "displayName": "Grok Build",
      "type": "grok",
      "command": "grok",
      "weight": 20
    }
  ],
  "showTotal": true
}
```
