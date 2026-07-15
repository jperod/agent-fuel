# ⚡️ Agent Fuel (`agent-fuel`)

A sleek, unified CLI dashboard to monitor your AI coding assistant quotas, credits, and token usage in real-time.

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

## 💡 The Motivation

AI coding assistants are now integral to developer workflows. Modern developers often use **multiple agentic CLI tools interchangeably** (such as **Claude Code**, **Codex CLI**, and **Google Antigravity CLI** — aka **AGY**, run via the `agy` command), switching back and forth depending on the task.

However, keeping track of your remaining fuel is a major hassle due to three reasons:

1. **Fragmented Quotas**: Each tool operates on its own isolated limit system (e.g., short-term 5-hour sessions or long-term weekly buckets) without any central tracking.
2. **Conflicting Conventions (Directionality)**: Different CLIs represent usage differently. Some measure **remaining capacity** (counting downwards, e.g., Codex or AGY's "X% left"), while others measure **consumed resources** (counting upwards, e.g., Claude Code's "Y% used"). A number like `51%` can mean completely opposite states depending on the tool.
3. **Avoiding Provider Lock-In**: To avoid ecosystem lock-in, developers naturally want to use a mix of tools (such as Claude Code, Codex, and AGY interchangeably for all their coding tasks). This standard practice forces you to manually manage and calculate completely separate and unrelated quota limits.

**Agent Fuel** solves this by acting as a lightweight, adapter-based abstraction layer that normalises all coding agent quotas into a single, unambiguous metric: **Percent Remaining**.

Built with an extensible adapter architecture, Agent Fuel provides a single unified pane of glass for all your active CLIs, and is designed to easily scale to support new agentic developer tools as they emerge in the future.

---

## 🎯 How It Works

`agent-fuel` is a tiny modern CLI built with TypeScript that:

1. **Dispatches Adapters concurrently** — all adapters run in parallel and each row is printed the moment its adapter resolves; you never wait for the slowest tool.
2. **Streams Consolidated Quota Live** — renders a weighted **Total** bar on top which calculates and updates in real-time as each provider finishes loading, showing the live calculated portion rather than waiting for all adapters to finish.
3. **Standardises Bottlenecks** — maps the primary percentage of each tool to its limiting bottleneck factor (the minimum of session and weekly limits).
4. **Live Limit Breakdown** — displays both short-term 5-hour/session limits and long-term weekly limits next to the progress bar (e.g. `(5h: 85% | wk: 84%)`) when both exist.
5. **Auto-fallback & Tags** — automatically falls back to the weekly limit when a 5h limit is absent (e.g., Codex on its new weekly-only system) and appends a `[weekly]` or `[session]` tag.
6. **Scrapes TUI output directly** — Codex and AGY quotas are read by spawning the real CLIs via `expect` and parsing terminal output, so the numbers match what the tools themselves show.
7. **Caches AGY results** — AGY quota is cached for 5 minutes so repeated runs are instant (~1s).

### Project Architecture

```text
agent-fuel/
  ├── src/
  │   ├── index.ts            # CLI entry point — runs all adapters concurrently
  │   ├── render.ts           # Colour-coded bar dashboard renderer
  │   ├── config.ts           # Config file manager & config command handler
  │   └── adapters/
  │       ├── index.ts        # Shared UsageSnapshot type & QuotaAdapter interface
  │       ├── claude.ts       # Claude Code (via ccusage blocks)
  │       ├── codex.ts        # Codex CLI (expect TUI scrape; ccusage as fallback estimate)
  │       └── agy.ts          # AGY — split into Gemini + Other buckets
  ├── package.json
  └── README.md
```

### Type Shape

```typescript
type UsageSnapshot = {
  tool: "codex" | "claude-code" | "agy-gemini" | "agy-other" | "total";
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

Total         [██████████████████████████░░░░]  86% remaining  (tune weights: agent-fuel config)

Claude Code   [█████████████████████████░░░░░]  84% remaining (5h: 85% | wk: 84%) (resets Jul 19, 14:59 (Europe/Copenhagen))
Codex         [███████████████████████████░░░]  89% remaining [weekly] (resets 22:47 on 21 Jul)
AGY Gemini    [███████████████████████░░░░░░░]  77% remaining (5h: 88% | wk: 77%) (resets in 116h 10m) [GEMINI MODELS]
AGY Other     [██████████████████████████████] 100% remaining (5h: 100% | wk: 100%) ✓ quota available [CLAUDE AND GPT MODELS]

agent-fuel v0.6.0
```

- **Total** bar prints on top (in TTY interactive mode) showing the weighted consolidated remaining quota. The bar and percentage represent the true bottleneck (minimum) remaining capacity.
- Rows appear as each adapter resolves — Claude Code (instant) prints first, Codex and AGY follow as their TUI scrapes complete.
- **Limit Breakdown**: For tools with both short-term 5-hour/session and long-term weekly limits, both are shown in the metadata text (e.g. `(5h: 85% | wk: 84%)`).
- **Limiting Tag**: For tools with a single active limit (like Codex on its weekly-only system), the limit type is explicitly tagged in grey (e.g., `[weekly]`).
- **AGY Models**: Cleaned labels display the active model group (e.g., `[GEMINI MODELS]`), dynamically stripping redundant limit type suffixes.

---

## ⚙️ Configuration & Custom Weights

Different developers operate under different quota sizes. By default, `agent-fuel` weights each provider bucket as standard proxies for monthly dollar subscription amounts:

- Claude Code (`claude-code`): `20`
- Codex CLI (`codex`): `20`
- AGY Gemini (`agy-gemini`): `10`
- AGY Other (`agy-other`): `10`

If a provider is completely unused or fails to return a quota percentage, its weight is **dynamically excluded** from the calculation, ensuring that missing/unused services don't break the consolidated bar.

### Managing Settings via the CLI

You can view or update your weights and settings directly using the CLI:

- **View Active Configuration**:
  ```bash
  agent-fuel config
  ```
- **Change Provider Weight**:
  ```bash
  agent-fuel config set claude-code 50
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
