# ⚡️ Agent Fuel — AI Coding CLI Quota & Token Usage Monitor

> **Track and monitor token usage, credits, and quota limits** for your AI coding assistants — Claude Code, Codex CLI, and Antigravity/AGY — in a single unified terminal dashboard.

[![npm version](https://img.shields.io/npm/v/agent-fuel?color=blue)](https://www.npmjs.com/package/agent-fuel)
[![npm downloads](https://img.shields.io/npm/dm/agent-fuel?color=green)](https://www.npmjs.com/package/agent-fuel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`agent-fuel` is a lightweight npm CLI tool that gives you a **real-time unified view of AI agent quota usage** across Claude Code, Codex, and AGY (Google Antigravity CLI) — supporting multiple accounts/profiles and custom shell aliases so you always know how much AI fuel you have left without switching between tools.

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

If you use **multiple AI coding assistants** (like Claude Code, Codex CLI, and Google's Antigravity CLI `agy`), or **multiple accounts** of the same tool (e.g., work vs personal Claude/Codex profiles):

- **Fragmented quota tracking**: each tool/account has separate credit limits with no central view
- **Inconsistent direction**: some tools show *remaining* %, others show *consumed* % — impossible to compare at a glance
- **Multi-account friction**: managing secondary accounts (e.g. `CLAUDE_CONFIG_DIR=~/.claude-personal` or aliases) required manual checks across terminals

**Agent Fuel** solves this with one command: `agent-fuel`. It normalises all limits into a single **Percent Remaining** metric, supports N accounts for any tool type, and streams them live in one terminal dashboard.

> **Supports:** Claude Code (Multi-account) · Codex CLI (Multi-account) · Antigravity CLI (AGY / Google Gemini)

---

## 💡 The Motivation

AI coding assistants are now integral to developer workflows. Modern developers often use **multiple agentic CLI tools and multiple accounts** (such as `claude` and `claude-personal`, work Codex, and AGY), switching back and forth depending on the task.

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
4. **Tool-Type Grouping** — groups accounts logically by tool type (`Claude` accounts together, `Codex` accounts together, `AGY` accounts together).
5. **Dynamic Alignment** — dynamically calculates column width so progress bars align perfectly across custom display names.

### Project Architecture

```text
agent-fuel/
  ├── src/
  │   ├── index.ts            # CLI entry point — orchestrates dynamic account adapters
  │   ├── render.ts           # Colour-coded bar dashboard renderer with dynamic label padding
  │   ├── config.ts           # Multi-account config manager & CLI command handler
  │   ├── tmux.ts             # Tmux TUI scraper & shell alias / env executor
  │   └── adapters/
  │       ├── index.ts        # Shared UsageSnapshot type & QuotaAdapter interface
  │       ├── claude.ts       # Claude Code (multi-account TUI scrape & prompt handler)
  │       ├── codex.ts        # Codex CLI (expect TUI scrape; ccusage fallback)
  │       └── agy.ts          # AGY — split into Gemini + Other buckets per account
  ├── package.json
  └── README.md
```

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

Claude Code     [███░░░░░░░░░░░░░░░░░░░░░░░░░░░]   9% remaining (5h: 100% | wk: 9%) (resets Aug 1 at 05:59 (Europe/Copenhagen))
Claude Personal [████████░░░░░░░░░░░░░░░░░░░░░░]  25% remaining (5h: 96% | wk: 25%) (resets Aug 2 at 14:59 (Europe/Copenhagen))
Codex           [███░░░░░░░░░░░░░░░░░░░░░░░░░░░]  11% remaining [weekly] (resets 09:10 on 5 Aug)
AGY Gemini      [█████████████████░░░░░░░░░░░░░]  56% remaining (5h: 92% | wk: 56%) (resets in 95h 16m) [GEMINI MODELS]
AGY Other       [██████████████████████████████] 100% remaining (5h: 100% | wk: 100%) ✓ quota available [CLAUDE AND GPT MODELS]

Total           [████████░░░░░░░░░░░░░░░░░░░░░░]  28% remaining  (tune weights: agent-fuel config)

agent-fuel v0.8.1 • Last refreshed at: 20:27
```

- **Total** bar prints on top showing the weighted consolidated remaining quota across all configured accounts.
- **Grouped Display**: All `Claude` accounts render together, followed by `Codex` and `AGY`.
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
  agent-fuel config set claude-code weight 50
  ```
- **Disable/Enable Total Bar**:
  ```bash
  agent-fuel config set show-total false
  ```

Settings are persistently saved to `~/.config/agent-fuel/config.json`.

---

## ⚙️ Environment Overrides

Environment variables take highest precedence and override any values saved in the config JSON file:

| Variable                       | Default | Description                                                    |
| ------------------------------ | ------- | -------------------------------------------------------------- |
| `AGENT_FUEL_CLAUDE_BUDGET`     | `20.0`  | Claude Code rolling budget in USD                              |
| `AGENT_FUEL_CODEX_BUDGET`      | `20.0`  | **Fallback estimate only** — Codex rolling budget in USD       |
| `AGENT_FUEL_WEIGHT_CLAUDE`     | `20`    | Weight size ratio of the Claude Code quota pool                |
| `AGENT_FUEL_WEIGHT_CODEX`      | `20`    | Weight size ratio of the Codex quota pool                      |
| `AGENT_FUEL_WEIGHT_AGY_GEMINI` | `10`    | Weight size ratio of the AGY Gemini quota pool                 |
| `AGENT_FUEL_WEIGHT_AGY_OTHER`  | `10`    | Weight size ratio of the AGY Other quota pool                  |
| `AGENT_FUEL_SHOW_TOTAL`        | `true`  | Show or hide the consolidated Total quota bar (`true`/`false`) |

> **Note on `AGENT_FUEL_CODEX_BUDGET`:** Codex quota is read directly from the Codex TUI via `expect` scraping. This variable is only used as a rough fallback estimate (shown as `[~est]`) when the TUI reports no quota warning and a percentage cannot be determined. It is a guess based on local session cost data — not an official Codex quota signal. The TUI scrape is always preferred.
