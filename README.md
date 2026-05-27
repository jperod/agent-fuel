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

AI coding assistants are now integral to developer workflows. Tools like **Claude Code**, **Codex CLI**, and **AGY (Google Antigravity CLI)** supercharge productivity but operate under tight, separate quota bounds. Developers are forced to jump through interactive prompts or scrape configuration screens just to answer:

> **"How much agent fuel do I have left before starting this massive refactor?"**

**Agent Fuel** solves this by acting as a lightweight, adapter-based abstraction layer that normalises all coding agent quotas into a single metric: **Percent Remaining**.

---

## 🎯 How It Works

`agent-fuel` is a tiny modern CLI built with TypeScript that:

1. **Dispatches Adapters concurrently** — all adapters run in parallel and each row is printed the moment its adapter resolves; you never wait for the slowest tool.
2. **Normalises Quota Models** — standardises diverse limits into a uniform `0–100%` score.
3. **Scrapes TUI output directly** — Codex and AGY quotas are read by spawning the real CLIs via `expect` and parsing terminal output, so the numbers match what the tools themselves show.
4. **Caches AGY results** — AGY quota is cached for 5 minutes so repeated runs are instant (~1s).
5. **Renders a clean dashboard** — colour-coded bars with reset times directly in your terminal.

### Project Architecture

```text
agent-fuel/
  ├── src/
  │   ├── index.ts            # CLI entry point — runs all adapters concurrently
  │   ├── render.ts           # Colour-coded bar dashboard renderer
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
  tool: 'codex' | 'claude-code' | 'agy-gemini' | 'agy-other';
  remainingPercent: number | null;   // Unified 0–100 scale
  usedPercent?: number | null;
  resetAt?: string | null;
  source: 'official-cli' | 'ccusage' | 'local-state' | 'provider-api' | 'cache' | 'unknown';
  raw?: unknown;
};
```

---

## 📊 Terminal Dashboard

```
⚡️ Agent Fuel - CLI Quota Monitor

Claude Code   [███████████████████░░░░░░░░░░░]  64% remaining (resets 01:00 PM)
Codex         [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   0% remaining (resets in 4h 33m)
AGY Gemini    [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   0% remaining (resets in 3h 16m) [Gemini 3.5 Flash (Medium)]
AGY Other     [██████████████████░░░░░░░░░░░░]  60% remaining (resets in 4h 47m) [Claude Sonnet 4.6 (Thinking)]

agent-fuel v0.3.0
```

Rows appear as each adapter resolves — Claude Code (instant) prints first, Codex and AGY follow as their TUI scrapes complete.

**AGY Gemini** shows the worst-case remaining across all `Gemini *` model tiers.  
**AGY Other** shows the worst-case across Claude and other non-Gemini models.  
**Codex** row tagged `[~est]` when quota has not been reached and the percentage is estimated from local session cost data (see fallback note below).

---

## ⚙️ Environment Overrides

| Variable | Default | Description |
|---|---|---|
| `AGENT_FUEL_CLAUDE_BUDGET` | `20.0` | Claude Code rolling budget in USD |
| `AGENT_FUEL_CODEX_BUDGET` | `20.0` | **Fallback estimate only** — Codex rolling budget in USD |

> **Note on `AGENT_FUEL_CODEX_BUDGET`:** Codex quota is read directly from the Codex TUI via `expect` scraping. This variable is only used as a rough fallback estimate (shown as `[~est]`) when the TUI reports no quota warning and a percentage cannot be determined. It is a guess based on local session cost data — not an official Codex quota signal. The TUI scrape is always preferred.

---

## 📦 Changelog

### v0.3.0
- **Codex TUI scrape**: replaced inaccurate `ccusage` cost estimate with an `expect` wrapper that reads the real Codex quota warning (`"Individual quota reached. Resets in Xh Ym"`) — same pattern as AGY. `ccusage` kept as a labelled `[~est]` fallback when quota has not yet been exhausted.
- **Streaming render with fixed order**: placeholder rows print immediately; each bar overwrites in-place as its adapter resolves. Row order is always `Claude Code → Codex → AGY Gemini → AGY Other`.
- **AGY split view**: Gemini and non-Gemini (Claude, etc.) quota buckets shown as separate rows
- **5-minute disk cache** for AGY quota — repeated runs complete in ~1s instead of ~20s
- Output size cap, typed `any` removal, env validation hardening

### v0.2.x
- AGY quota now scraped live from `agy /usage` panel via `expect` wrapper (zero token cost)
- Claude Code budget corrected to $20 rolling limit
- Replaced token-consuming `claude -p` calls with offline `ccusage` scraping
