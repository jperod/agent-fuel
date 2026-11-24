# Agent Fuel

Unified terminal dashboard for remaining quota, credits, and rate-limit windows across Claude Code, Codex CLI, Cursor Agent, Antigravity CLI (`agy`), and Grok Build.

[![npm version](https://img.shields.io/npm/v/agent-fuel?color=blue)](https://www.npmjs.com/package/agent-fuel)
[![npm downloads](https://img.shields.io/npm/dm/agent-fuel?color=green)](https://www.npmjs.com/package/agent-fuel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install & Run

```bash
npm install -g agent-fuel
agent-fuel
```

Pass `--debug` to write redacted adapter traces to `~/.config/agent-fuel/logs/` (`0600`).

### Local Development

```bash
git clone https://github.com/jperod/agent-fuel.git
cd agent-fuel
npm install
npm test
npm link
```

## Terminal Output

Every provider reports on the same `0–100% remaining` scale, sorted by tool type (`Claude` -> `Codex` -> `Cursor Agent` -> `AGY` -> `Grok Build`) using the tightest active limit window as the headline percentage.

```text
⚡️ Agent Fuel - CLI Quota Monitor

Total           [██████████████░░░░░░░░░░░░░░░░]  47% remaining  (tune weights: agent-fuel config)

Claude Code     [██████████████░░░░░░░░░░░░░░░░]  48% remaining (5h: 77% | wk: 48%) (resets Nov 28 at 05:00 (Europe/Copenhagen))
Claude Personal [████████░░░░░░░░░░░░░░░░░░░░░░]  27% remaining (5h: 27% | wk: 46%) (resets 18:40 (Europe/Copenhagen))
Codex           [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   0% remaining (5h: 0% | wk: 30%) (resets 18:58)
Cursor Agent    [█████████████████████████████░]  98% remaining [weekly] (resets Nov 27) [free]
AGY ╭ Gemini    [██████████████░░░░░░░░░░░░░░░░]  45% remaining (5h: 45% | wk: 85%) (resets in 1h 38m) [GEMINI MODELS]
    ╰ Other     [███████████████░░░░░░░░░░░░░░░]  50% remaining (5h: 100% | wk: 50%) (resets in 91h 14m) [CLAUDE AND GPT MODELS]
Grok Build      [█████████████████████░░░░░░░░░]  70% remaining (5h: 85% | wk: 70%) (resets in 18h)

agent-fuel v0.9.3 • Last refreshed at: 16:03
```

## Supported Providers

| Provider | Type | Primary Source | Fallback |
|---|---|---|---|
| Claude Code | `claude` | `claude auth status` + tmux `/usage` | — |
| Codex CLI | `codex` | `codex app-server` JSON-RPC | tmux `/status`, 1h cache, `ccusage` |
| Cursor Agent | `cursor` | Connect-RPC (`GetCurrentPeriodUsage` + `GetPlanInfo`) | tmux `--trust` `/usage` |
| Antigravity CLI | `agy` | `agy -p "/usage" --output-format json` | tmux `/usage` |
| Grok Build | `grok` | tmux `/usage` (`/cost` retry) | 10m cache |

See [docs/adapters.md](docs/adapters.md) for extraction flows, credential resolution, and cache behavior.

## Configuration

Accounts and display options live in `~/.config/agent-fuel/config.json` (`0600` permissions; sensitive `--env` values are masked by `config list`). Manage them via `agent-fuel config`:

```bash
# View accounts, weights, and settings
agent-fuel config

# Add secondary profiles or custom commands
agent-fuel config add-account claude-personal --type claude --name "Claude Personal" --env CLAUDE_CONFIG_DIR=~/.claude-personal
agent-fuel config add-account codex-work --type codex --name "Codex Work" --cmd codex-work
agent-fuel config add-account cursor --type cursor --name "Cursor Agent"
agent-fuel config add-account grok --type grok --name "Grok Build" --env GROK_HOME=~/.grok-work

# Adjust Total bar weights or visibility
agent-fuel config set cursor weight 25
agent-fuel config set agy gemini 15
agent-fuel config set show-total false

# Remove an account
agent-fuel config remove-account claude-personal
```

<details>
<summary>Example ~/.config/agent-fuel/config.json</summary>

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
    }
  ],
  "showTotal": true
}
```

</details>

## Environment Variables

Environment variables override `~/.config/agent-fuel/config.json`:

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_FUEL_SHOW_TOTAL` | `true` | Toggle consolidated `Total` row (`true` / `false`) |
| `AGENT_FUEL_WEIGHT_<ID>` | `20` | Weight override for account `<ID>` (uppercased, `-` to `_`) |
| `AGENT_FUEL_WEIGHT_<TYPE>` | `20` | Weight override by type (`CLAUDE`, `CODEX`, `CURSOR`, `AGY`, `GROK`) |
| `AGENT_FUEL_WEIGHT_AGY_GEMINI` | `5/6` of AGY weight | Weight for AGY `Gemini` pool (`AGENT_FUEL_WEIGHT_<ID>_GEMINI` per account) |
| `AGENT_FUEL_WEIGHT_AGY_OTHER` | `1/6` of AGY weight | Weight for AGY `Other` pool (`AGENT_FUEL_WEIGHT_<ID>_OTHER` per account) |
| `AGENT_FUEL_CODEX_BUDGET` | `20.0` | USD budget used only by the `[~est]` `ccusage` fallback |
| `CURSOR_API_KEY` / `CURSOR_ACCESS_TOKEN` | — | Cursor authentication token override |
| `CURSOR_API_ENDPOINT` | `https://api2.cursor.sh` | Cursor Connect-RPC base URL |
| `GROK_CMD` | `grok` | Executable or alias override for Grok Build |

## Code Layout

- `src/index.ts` — concurrent adapter runner, slot ordering, and live TTY redraw
- `src/config.ts` — config persistence (`~/.config/agent-fuel/config.json`) and `config` subcommand
- `src/render.ts` — ANSI progress bar formatting and reset/tier badges
- `src/tmux.ts` — headless tmux scraper, ANSI stripper, and shell-alias env helpers
- `src/adapters/` — `agy.ts`, `claude.ts`, `codex.ts`, `cursor.ts`, `grok.ts`, shared `UsageSnapshot` contract (`index.ts`)
- `tests/adapters.test.mjs` — parser, snapshot builder, renderer, and security unit tests

## Security & License

Subprocess probes and `tmux` scrapers run inside an isolated `0700` workspace (`~/.config/agent-fuel/workspace`) rather than the caller's current working directory, config/cache/debug files use `0600` permissions, and `CURSOR_API_ENDPOINT` refuses non-HTTPS URLs or sending Keychain credentials to non-Cursor domains.

Released under the [MIT License](LICENSE).
