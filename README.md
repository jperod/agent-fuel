# ⚡️ Agent Fuel (`agent-fuel`)

A sleek, unified CLI dashboard to monitor your AI coding assistant quotas, credits, and token usage in real-time.

---

## 🚀 Installation & Running

Install **Agent Fuel** globally on your system in one step:

```bash
npm install -g agent-fuel
```

Once installed, you can run the dashboard at any time from **any directory** on your machine by simply typing:

```bash
agent-fuel
```

### Development Setup
If you want to run or contribute to `agent-fuel` locally:
```bash
git clone https://github.com/jperod/agent-fuel.git
cd agent-fuel
npm install
npm run build
npm link
```

---

## 💡 The Motivation

AI coding assistants are now integral to developer workflows. Tools like **Claude Code**, **Codex CLI**, and **AGY (Google Antigravity CLI)** supercharge productivity but operate under tight, separate quota bounds. Whether it is a daily dollar limit, token ceilings, or monthly credits, developers are forced to jump through interactive prompts or scrape configuration screens just to answer a simple question:

> **"How much agent fuel do I have left before starting this massive refactor?"**

Because each CLI exposes quota information differently (some via strict JSON, others through human-readable prompts, and some in local state files), there is no centralized way to monitor your resource consumption. 

**Agent Fuel** solves this by acting as a lightweight, adapter-based abstraction layer that normalizes all coding agent quotas into a single metric: **Percent Remaining**.

---

## 🎯 The Idea

`agent-fuel` is a tiny, modern local CLI built with TypeScript that:
1. **Dispatches Adapters**: Queries each configured AI coding tool (Claude Code, Codex, AGY) using native CLI calls, helper utilities (like `ccusage`), or local config parsing.
2. **Normalizes Quota Models**: Standardizes diverse limits into a uniform percentage score (`0` to `100%`).
3. **Renders an Elegant CLI Dashboard**: Displays a high-fidelity 3-bar ASCII progress dashboard directly in your terminal.

### Project Architecture

```text
agent-fuel/
  ├── src/
  │   ├── index.ts          # CLI entry point
  │   ├── render.ts         # Beautiful 3-bar dashboard renderer
  │   └── adapters/
  │       ├── claude.ts     # Adapter for Claude Code (ccusage blocks)
  │       ├── codex.ts      # Adapter for Codex (ccusage codex session)
  │       └── agy.ts        # Adapter for AGY (Antigravity history & model config parser)
  ├── package.json
  └── README.md
```

### High-Fidelity API Type Shape

```typescript
type UsageSnapshot = {
  tool: 'codex' | 'claude-code' | 'agy';
  remainingPercent: number | null; // Unified 0-100 scale
  usedPercent?: number | null;
  resetAt?: string | null;
  source: 'official-cli' | 'ccusage' | 'local-state' | 'provider-api' | 'unknown';
  raw?: unknown;
};
```

---

## 📊 Terminal Dashboard Preview

Running `agent-fuel` will immediately output a clean, colored visual summary of your current agent capacity:

```text
⚡️ Agent Fuel - CLI Quota Monitor

Codex        [██████████████████████████████]  99% remaining (resets 01:49 PM)
Claude Code  [█████████████████████████░░░░░]  83% remaining (resets 01:00 PM)
AGY          [██████████████████░░░░░░░░░░░░]  60% remaining (resets 01:57 PM) [Gemini 3.5 Flash (High)]
```


