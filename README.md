# ⚡️ Agent Fuel — AI Coding CLI Quota & Token Usage Monitor

> **Track and monitor token usage, credits, and quota limits** for your AI coding assistants — Claude Code, Codex CLI, Cursor Agent, Antigravity/AGY, and Grok Build — in a single unified terminal dashboard.

[![npm version](https://img.shields.io/npm/v/agent-fuel?color=blue)](https://www.npmjs.com/package/agent-fuel)
[![npm downloads](https://img.shields.io/npm/dm/agent-fuel?color=green)](https://www.npmjs.com/package/agent-fuel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`agent-fuel` is a lightweight npm CLI tool that gives you a **real-time unified view of AI agent quota usage** across Claude Code, Codex, Cursor Agent, AGY (Google Antigravity CLI), and Grok Build (xAI / SpaceXAI) — supporting multiple accounts/profiles and custom shell aliases so you always know how much AI fuel you have left without switching between tools.

---

## 🚀 Installation & Running

Install **Agent Fuel** globally:

```bash
npm install -g agent-fuel
```

Then run from any directory:

```bash
agent-fuel
```

### Development Setup

```bash
git clone https://github.com/jperod/agent-fuel.git
cd agent-fuel
npm install
npm run build
npm link
```

---

## 🔍 What Problem Does This Solve?

If you use **multiple AI coding assistants** (like Claude Code, Codex CLI, Cursor Agent `cursor-agent`, Google's Antigravity CLI `agy`, and xAI's Grok Build `grok`), or **multiple accounts** of the same tool (e.g., work vs personal Claude, Codex, or Cursor profiles):

- **Fragmented quota tracking**: each tool/account has separate credit limits with no central view
- **Inconsistent direction**: some tools show *remaining* %, others show *consumed* % — impossible to compare at a glance
- **Multi-account friction**: managing secondary accounts (e.g. `CLAUDE_CONFIG_DIR=~/.claude-personal` or aliases) required manual checks across terminals

**Agent Fuel** solves this with one command: `agent-fuel`. It normalises all limits into a single **Percent Remaining** metric, supports N accounts for any tool type, and streams them live in one terminal dashboard.

> **Supports:** Claude Code (Multi-account) · Codex CLI (Multi-account) · Cursor Agent (Multi-account / Pro & Business) · Antigravity CLI (AGY / Google Gemini) · Grok Build (xAI / SpaceXAI)

---

## 💡 The Motivation

AI coding assistants are now integral to developer workflows. Modern developers often use **multiple agentic CLI tools and multiple accounts** (such as `claude` and `claude-personal`, work Codex, Cursor Agent, AGY, and Grok Build), switching back and forth depending on the task.

However, keeping track of your remaining fuel is a major hassle due to three reasons:

1. **Fragmented Quotas & Accounts**: Each tool and account operates on its own isolated limit system without any central tracking.
2. **Conflicting Conventions (Directionality)**: Different CLIs represent usage differently (e.g., remaining capacity vs consumed resources).
3. **Avoiding Provider Lock-In**: Developers use a mix of tools and accounts interchangeably for all their coding tasks.

**Agent Fuel** solves this by acting as a lightweight, adapter-based abstraction layer that normalises all coding agent quotas into a single, unambiguous metric: **Percent Remaining**.

---

## 🎯 How It Works

`agent-fuel` is a tiny modern CLI built with TypeScript that:

1. **Dispatches Adapters concurrently** — all configured accounts run in parallel and each row is printed the moment its adapter resolves.
2. **Multi-Account & Shell Alias Aware** — resolves custom environment variables (e.g., `CLAUDE_CONFIG_DIR=~/.claude-personal`) and shell aliases inside tmux scraper sessions.
3. **Streams Consolidated Quota Live** — renders a weighted **Total** bar on top which calculates and updates in real-time as each provider finishes loading.
4. **Tool-Type Grouping** — groups accounts logically by tool type (`Claude` accounts together, `Codex` accounts together, `Cursor Agent` accounts together, `AGY` accounts together, `Grok Build` accounts together).
5. **Dynamic Alignment** — dynamically calculates column width so progress bars align perfectly across custom display names.

### Project Architecture

```text
agent-fuel/
  ├── docs/
  │   └── adapters.md         # In-depth adapter mechanics, authentication & config guide
  ├── src/
  │   ├── index.ts            # CLI entry point — orchestrates dynamic account adapters
  │   ├── render.ts           # Colour-coded bar dashboard renderer with dynamic label padding
  │   ├── config.ts           # Multi-account config manager & CLI command handler
  │   ├── tmux.ts             # Tmux TUI scraper & shell alias / env executor
  │   └── adapters/
  │       ├── index.ts        # Shared UsageSnapshot type & QuotaAdapter interface
  │       ├── claude.ts       # Claude Code (multi-account TUI scrape & prompt handler)
  │       ├── codex.ts        # Codex CLI (expect TUI scrape; ccusage fallback)
  │       ├── cursor.ts       # Cursor Agent (direct Connect API query; TUI scrape fallback)
  │       ├── agy.ts          # AGY — split into Gemini, Other, and Argon buckets per account
  │       └── grok.ts         # Grok Build (xAI / SpaceXAI TUI scrape & session limits)
  ├── package.json
  └── README.md
```

> 📖 **Deep Dive Documentation:** For detailed per-provider extraction lifecycles, Keychain token resolution, and fallback flows, see the [Adapters & Configuration Guide](docs/adapters.md).

### Type Shape

```typescript
type UsageSnapshot = {
  tool: string;                    // Dynamic Account ID (e.g., "claude-code", "claude-personal")
  displayName?: string;            // Custom label (e.g., "Claude Personal")
  remainingPercent: number | null; // Unified 0–100 scale
  usedPercent?: number | null;
  resetAt?: string | null;
  source:
    | "official-cli"
    | "ccusage"
    | "local-state"
    | "provider-api"
    | "cache"
    | "unknown";
  isLoading?: boolean;
  weeklyLimitReached?: boolean;
  limitType?: "session" | "weekly";
  breakdown?: {
    fiveHour: number | null;
    weekly: number | null;
  };
  raw?: unknown;
};
```

---

## 📊 Terminal Dashboard

```
⚡️ Agent Fuel - CLI Quota Monitor

Claude Code       [███░░░░░░░░░░░░░░░░░░░░░░░░░░░]   9% remaining (5h: 100% | wk: 9%) (resets Aug 1 at 05:59 (Europe/Copenhagen))
Claude Personal   [████████░░░░░░░░░░░░░░░░░░░░░░]  25% remaining (5h: 96% | wk: 25%) (resets Aug 2 at 14:59 (Europe/Copenhagen))
Codex             [███░░░░░░░░░░░░░░░░░░░░░░░░░░░]  11% remaining [weekly] (resets 09:10 on 5 Aug)
Cursor Agent      [██████████████████████████████] 100% remaining [weekly] (resets Oct 23)
AGY ╭ Flash & Pro [█████████████████░░░░░░░░░░░░░]  56% remaining (5h: 92% | wk: 56%) (resets in 95h 16m) [GEMINI MODELS]
    │ Argon       [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   0% remaining (wk: 0%) (resets in 165h 46m) [GEMINI 4 ARGON] ⚠️ weekly limit
    ╰ Other       [██████████████████████████████] 100% remaining (5h: 100% | wk: 100%) ✓ quota available [CLAUDE AND GPT MODELS]
Grok Build        [█████████████████████░░░░░░░░░]  70% remaining (5h: 85% | wk: 70%) (resets in 18h)

Total             [████████░░░░░░░░░░░░░░░░░░░░░░]  34% remaining  (tune weights: agent-fuel config)

agent-fuel v0.9.1 • Last refreshed at: 11:44
```

- **Total** bar prints on top showing the weighted consolidated remaining quota across all configured accounts.
- **Grouped Display**: All `Claude` accounts render together, followed by `Codex`, `Cursor Agent`, `AGY`, and `Grok Build`.
- **Limit Breakdown**: Session vs weekly limits shown in metadata (e.g. `(5h: 96% | wk: 25%)`).

---

## ⚙️ Configuration & Multi-Account Setup

Settings are persistently saved to `~/.config/agent-fuel/config.json`.

### Managing Accounts & Settings via the CLI

You can list, add, remove, and update accounts directly using the CLI:

- **View Active Configuration**:
  ```bash
  agent-fuel config
  ```
- **Add a Secondary Claude Account**:
  ```bash
  agent-fuel config add-account claude-personal --type claude --name "Claude Personal" --env CLAUDE_CONFIG_DIR=~/.claude-personal
  ```
- **Add a Standard Cursor Agent Account**:
  ```bash
  agent-fuel config add-account cursor --type cursor --name "Cursor Agent"
  ```
- **Add a Work / Secondary Cursor Agent Account** (with custom command or API key):
  ```bash
  agent-fuel config add-account cursor-work --type cursor --name "Cursor Work" --cmd cursor-agent --env CURSOR_API_KEY="key-..."
  ```
- **Add a Standard Grok Build Account**:
  ```bash
  agent-fuel config add-account grok --type grok --name "Grok Build"
  ```
- **Add a Work / Secondary Grok Build Account** (with custom config dir or API key):
  ```bash
  agent-fuel config add-account grok-work --type grok --name "Grok Work" --env GROK_HOME=~/.grok-work --env XAI_API_KEY="xai-..."
  ```
- **Add a Custom Codex Account**:
  ```bash
  agent-fuel config add-account codex-work --type codex --name "Codex Work" --cmd codex-work
  ```
- **Remove an Account**:
  ```bash
  agent-fuel config remove-account claude-personal
  ```
- **Set Weight for an Account**:
  ```bash
  agent-fuel config set cursor weight 25
  ```
- **Disable/Enable Total Bar**:
  ```bash
  agent-fuel config set show-total false
  ```

### Example `~/.config/agent-fuel/config.json`

Here is an example configuration file monitoring Claude, Codex, Cursor Agent, AGY, and Grok Build simultaneously:

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
    },
    {
      "id": "grok-work",
      "displayName": "Grok Work",
      "type": "grok",
      "command": "grok",
      "env": {
        "GROK_HOME": "~/.grok-work",
        "XAI_API_KEY": "xai-..."
      },
      "weight": 20
    }
  ],
  "showTotal": true
}
```

---

## ⚙️ Environment Overrides

Environment variables take highest precedence and override any values saved in the config JSON file:

| Variable                       | Default | Description                                                    |
| ------------------------------ | ------- | -------------------------------------------------------------- |
| `AGENT_FUEL_CLAUDE_BUDGET`     | `20.0`  | Claude Code rolling budget in USD                              |
| `AGENT_FUEL_CODEX_BUDGET`      | `20.0`  | **Fallback estimate only** — Codex rolling budget in USD       |
| `AGENT_FUEL_WEIGHT_CLAUDE`     | `20`    | Weight size ratio of the Claude Code quota pool                |
| `AGENT_FUEL_WEIGHT_CODEX`      | `20`    | Weight size ratio of the Codex quota pool                      |
| `AGENT_FUEL_WEIGHT_CURSOR`     | `20`    | Weight size ratio of the Cursor Agent quota pool               |
| `AGENT_FUEL_WEIGHT_AGY_GEMINI` | `10`    | Weight size ratio of the AGY Flash & Pro quota pool            |
| `AGENT_FUEL_WEIGHT_AGY_ARGON`  | `2`     | Weight size ratio of the AGY Argon quota pool                  |
| `AGENT_FUEL_WEIGHT_AGY_OTHER`  | `2`     | Weight size ratio of the AGY Other (Claude/GPT) quota pool     |
| `AGENT_FUEL_WEIGHT_GROK`       | `20`    | Weight size ratio of the Grok Build quota pool                 |
| `AGENT_FUEL_SHOW_TOTAL`        | `true`  | Show or hide the consolidated Total quota bar (`true`/`false`) |
| `CURSOR_API_KEY`               | —       | Direct authentication key for Cursor Connect API query         |
| `CURSOR_ACCESS_TOKEN`          | —       | Direct authentication token for Cursor Connect API query       |

> **Note on `AGENT_FUEL_CODEX_BUDGET`:** Codex quota is read directly from the Codex TUI via scraping. This variable is only used as a rough fallback estimate (shown as `[~est]`) when the TUI reports no quota warning and a percentage cannot be determined. It is a guess based on local session cost data — not an official Codex quota signal. The TUI scrape is always preferred.

> **Note on Cursor Agent:** Cursor Agent quota is obtained using a dual-engine adapter:
> 1. **Direct Connect API Query (`source: provider-api`)**: Fast request to Cursor's Dashboard API (`https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`), automatically retrieving tokens from macOS Keychain (`cursor-access-token` for `cursor-user`) or `CURSOR_API_KEY` / `CURSOR_ACCESS_TOKEN` environment variables (~50ms execution).
> 2. **Headless TUI Scraper Fallback (`source: official-cli`)**: If no token is configured or the API request fails, `agent-fuel` launches `cursor-agent` in a headless tmux session, automatically accepts workspace trust and update dialogs, triggers `/usage`, and scrapes live plan percentage and weekly reset dates.
> Quotas are securely cached for 5 minutes (`~/.config/agent-fuel/cursor-quota-*.json` with `0o600` permissions) to minimize background traffic.

> **Note on Grok Build:** Grok Build quota and credit usage are read directly from the Grok Build TUI via headless tmux scraping (`/usage` or `/cost`), querying live allowance and rolling window limits while respecting custom `GROK_HOME` and `XAI_API_KEY` configurations.
