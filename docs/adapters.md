# Adapter Architecture and Extraction Flows

`agent-fuel` runs one `QuotaAdapter` per configured account concurrently and normalizes every response into `UsageSnapshot` (`remainingPercent: 0–100`). When an account exposes multiple windows (such as 5-hour and weekly), the lowest remaining percentage sets the headline bar while individual windows go into `breakdown`.

Where a CLI exposes structured JSON or RPC, the adapter uses it directly instead of spawning `tmux` so results return in ~50ms–4s and avoid terminal rendering races. Interactive `tmux` scraping remains for CLIs without a structured quota endpoint (`claude`, `grok`) and as a fallback for older CLI binaries. All external CLI and `tmux` probes execute in an empty `0700` workspace (`~/.config/agent-fuel/workspace`) rather than the caller's working directory.

## Provider Matrix

| Provider | Type | Primary Engine | Fallback Path | Cache Location & TTL |
|---|---|---|---|---|
| Antigravity (`agy`) | `agy` | `agy -p "/usage" --output-format json` | tmux `/usage` | `~/.config/agent-fuel/agy-quota-<hash>.json` (5m TTL, 30m stale) |
| Claude Code | `claude` | `claude auth status` + tmux `/usage` | — | None |
| Codex CLI | `codex` | `codex app-server` JSON-RPC | tmux `/status` -> 1h cache -> `ccusage` | `~/.config/agent-fuel/codex-quota-<hash>.json` (1h fallback only) |
| Cursor Agent | `cursor` | `GetCurrentPeriodUsage` + `GetPlanInfo` | tmux `--trust` `/usage` | `~/.config/agent-fuel/cursor-quota-<hash>.json` (5m TTL) |
| Grok Build | `grok` | tmux `/usage` (`/cost` retry) | 10m cache | `~/.config/agent-fuel/grok-quota-<hash>.json` (10m fallback only) |

---

## 1. Antigravity CLI (`src/adapters/agy.ts`)

**Why this design:** AGY `1.1.11+` evaluates read-only slash commands in `-p` mode without starting a turn or spending tokens. In AGY `1.5.x`, Gemini 4 Argon shares the unified `Gemini Models` pool alongside Gemini 4 Neon, Carbon, Hydrogen, Orchestrator, and Gemini 3.8 Flash, so the adapter renders two default rows (`AGY ╭ Gemini` and `    ╰ Other` at a 5:1 weight ratio) and inserts extra tree rows only if AGY reports additional groups.

- **Adapter -> Cache:** Returns cached buckets if `~/.config/agent-fuel/agy-quota-<hash>.json` (`0600`) is under 5 minutes old.
- **Adapter -> AGY CLI:** Runs `<cmd> -p /usage --output-format json` (retrying via `$SHELL -i -c` on `ENOENT` for shell aliases). Reads `command.data.groups[].buckets[]`, converting `remaining_fraction` to percentages and `reset_time` (`1970-01-01T00:00:00Z` -> `Quota available`) to relative durations. `GEMINI_API_KEY` / `AI Studio` and auth errors map directly to `billing active` / `not logged in`.
- **Adapter -> tmux fallback:** On older AGY builds without JSON `-p /usage`, starts `<cmd>` in tmux, confirms trust prompts, opens `/usage`, and parses the `Models & Quota` panel.

## 2. Claude Code (`src/adapters/claude.ts`)

**Why this design:** Claude Code's OAuth usage endpoint is aggressively rate-limited (`429`), and `/status` tab positions shift across versions. Running `claude auth status` first detects logged-out profiles in ~150ms without hitting the onboarding wizard, while sending `/usage` directly inside tmux works across Team, Pro, Max, Enterprise, `CLAUDE_CONFIG_DIR` profiles, and shell aliases.

- **Adapter -> Auth check:** Runs `<cmd> auth status` (with `CLAUDE_CONFIG_DIR` / shell-alias fallback). If `loggedIn === false`, returns `not logged in` immediately.
- **Adapter -> Claude TUI:** Starts `DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 <cmd>` in tmux. Because Claude Code `2.1.x` focuses `No, exit` by default on folder trust prompts, the scraper waits 300ms for input hydration, sends `Down`, verifies `❯ Yes, I trust this folder` is highlighted on screen, and then sends `Enter`.
- **Adapter -> Usage tab:** Sends `/usage` (re-pressing `Enter` if stuck in slash autocomplete), waits for `% used` bars while ignoring `Refreshing` / `Scanning local sessions` placeholders, and parses `Current session` and `Current week` independently of `Extra usage`.

## 3. Codex CLI (`src/adapters/codex.ts`)

**Why this design:** `codex app-server` speaks JSON-RPC over stdio and returns exact `usedPercent`, `windowDurationMins`, `resetsAt` epoch timestamps, and `planType` in ~1–2s without TUI redraws or daemon prompts.

- **Adapter -> `codex app-server`:** Spawns `<cmd> app-server` (with shell-alias fallback), completes `initialize` / `initialized`, and calls `account/read` + `account/rateLimits/read`. Missing auth returns `not logged in` immediately; `planType === "free"` sets `[free]`.
- **Adapter -> tmux `/status` fallback:** If `app-server` is unavailable, launches `CODEX_NON_INTERACTIVE=1 <cmd>` in tmux, dismisses update, new-model, or daemon incompatibility dialogs, sends `/status`, and parses the latest limit bars while preventing model-specific sub-limits from overwriting primary `5h`/`weekly` rows.
- **Adapter -> `ccusage` last resort:** If live checks and the 1h disk cache (`0600`) both fail, invokes `npx --no-install ccusage codex session --json` (or `@ccusage/codex`) directly via `execFile` in the isolated workspace directory against `AGENT_FUEL_CODEX_BUDGET` (`$20.00` default) and marks the row `[~est]`.

## 4. Cursor Agent (`src/adapters/cursor.ts`)

**Why this design:** `GetCurrentPeriodUsage` returns usage percentages and billing cycle timestamps but omits subscription tier, so querying `GetPlanInfo` in parallel is required to surface `[free]` and distinguish weekly (Free) from monthly (Pro/Team) reset periods.

- **Adapter -> Cache:** Serves `~/.config/agent-fuel/cursor-quota-<hash>.json` (`0600`) for 5 minutes; automatically invalidates legacy `provider-api` cache entries missing `isFreeTier`.
- **Adapter -> Cursor Connect-RPC:** Resolves a token from `account.env` (`CURSOR_API_KEY` / `CURSOR_ACCESS_TOKEN`), `process.env`, or macOS Keychain (`security find-generic-password -s "cursor-access-token" -a "cursor-user" -w`), then posts `{}` concurrently to `GetCurrentPeriodUsage` and `GetPlanInfo` on `CURSOR_API_ENDPOINT` (default `https://api2.cursor.sh`; requires `https://` and refuses sending Keychain tokens or ambient env overrides to non-`cursor.sh`/`cursor.com` domains).
- **Adapter -> tmux fallback:** When no token is present or HTTP fails, spawns `<cmd> --trust` in a `200x50` tmux pane, handles `[a] Trust this workspace` if shown, runs `/usage`, and parses `Usage • Free`, percentage used, and both `27 Nov` and `Nov 27` reset formats.

## 5. Grok Build (`src/adapters/grok.ts`)

**Why this design:** Grok Build tracks rolling/weekly pools inside its interactive TUI via `/usage` (with `/cost` as secondary command) and respects `GROK_HOME`, `XAI_API_KEY`, and `GROK_CMD`.

- **Adapter -> Availability check:** Checks `command` (or `GROK_CMD`) on `PATH` and in `$SHELL -i -c` so shell aliases are not prematurely skipped.
- **Adapter -> Grok TUI:** Launches `<cmd>` in tmux, dismisses trust/update prompts, runs `/usage` (retrying `/cost`), and parses decimal/integer percentages, credit ratios (`$X / $Y`), `"You hit your weekly limit"`, and spending cap messages. Falls back to a 10m `0o600` cache if scraping fails.
