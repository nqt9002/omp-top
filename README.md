# omp-top

A lightweight fullscreen terminal monitor for **Oh My Pi (OMP)**. `omp-top` gives you one place to inspect request/cache statistics, cache efficiency by provider and model, and provider-account quota without opening a browser or running a full IDE.

## Highlights

- Overall request, token, cache-read/cache-write, cache hit-rate, and cache-savings metrics.
- Cache breakdown by **provider** and exact **model**.
- Progressive quota rendering: fast providers appear first; slower providers such as Claude update later without blocking the rest of the UI.
- Last-known quota remains visible while a live refresh is in progress.
- Uses OMP's own stats/auth/usage mechanisms; `omp-top` does not implement provider OAuth or store provider secrets.
- Read-only monitoring UI: no web server, Electron shell, MCP manager, editor, or arbitrary command surface.
- OMP profile support and account-identity redaction.

## How it works

Stats use OMP's official `@oh-my-pi/omp-stats` package:

1. `syncAllSessions()` incrementally syncs new session JSONL entries into OMP's stats database.
2. `getDashboardStats()` provides request/cache/model aggregates.

Quota refresh uses one background `omp usage --json` run. While it is still running, `omp-top` watches OMP's read-only `usage_history` snapshots and progressively updates providers/accounts as each result becomes available. A slow Claude usage request therefore does not hold back Codex, Gemini, or already-cached quota.

```text
OMP sessions ──> syncAllSessions() ──> stats/cache ──┐
                                                    │
OMP usage ─────> usage_history snapshots ───────────┼──> omp-top TUI
       ├─ Codex done   ─────────────────────────────┤
       ├─ Gemini done  ─────────────────────────────┤
       └─ Claude later ─────────────────────────────┘
```

## Requirements

- macOS or another Unix-like environment supported by OMP/Bun
- OMP already installed and available as `omp`
- Bun `>= 1.3.14`

## Install

Clone the repository and run the installer:

```bash
git clone https://github.com/nqt9002/omp-top.git
cd omp-top
chmod +x install.sh
./install.sh
```

The installer detects your installed OMP version and installs matching versions of:

- `@oh-my-pi/omp-stats`
- `@oh-my-pi/pi-tui`
- `@oh-my-pi/pi-utils`

The application is installed under:

```text
~/.local/share/omp-top
```

and the launcher is created at:

```text
~/.local/bin/omp-top
```

If `~/.local/bin` is not already in your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Usage

```bash
omp-top
```

At startup, `omp-top` shows the last-known quota immediately where available, refreshes stats, and starts a background quota refresh.

### Keyboard controls

| Key | Action |
| --- | --- |
| `r` | Refresh stats and start quota refresh if one is not already running |
| `↑` / `↓` | Scroll |
| `j` / `k` | Scroll |
| `PgUp` / `PgDn` | Page scroll |
| `Home` / `End` | Jump to top/bottom |
| `q` / `Esc` | Exit |
| `Ctrl+D` / `Ctrl+C` | Exit |

## Cache metrics

`omp-top` shows cache at three levels.

### Overall

Aggregate request and cache statistics across OMP sessions.

### By provider

Provider-level totals are computed from summed token counters rather than averaging model percentages. The cache-hit definition matches OMP:

```text
cache read / (uncached input + cache read)
```

### By model

Each exact model row includes request count, cache hit rate, cache-read tokens, cache-write tokens, and cache savings. This makes it easy to compare, for example, Codex, Claude, Gemini, and DeepSeek workloads individually.

## Progressive quota refresh

Quota is intentionally not treated as one blocking batch.

Example lifecycle:

```text
OpenAI Codex       ✓ fresh
Google Antigravity ✓ fresh
Anthropic          ↻ refreshing · showing previous snapshot
```

When Anthropic finishes, only that section changes to fresh. Existing quota is not deleted simply because a refresh is slow or temporarily fails.

OMP itself controls credentials, OAuth refresh, provider retries, and usage caching. `omp-top` only renders the normalized/resulting data.

## Profiles

Use a specific OMP profile:

```bash
omp-top --profile my-profile
```

The profile is applied before OMP stats modules are loaded and is inherited by the background `omp usage` process.

## Redact account identities

```bash
omp-top --redact
```

This masks account identity fields in the quota display.

## Optional hard quota timeout

By default v0.3 does not impose a short global timeout over OMP's quota batch because individual providers can legitimately take longer.

If you explicitly want a hard cap:

```bash
omp-top --quota-timeout 30000
```

or:

```bash
OMP_TOP_QUOTA_HARD_TIMEOUT_MS=30000 omp-top
```

`0` means no extra `omp-top` hard cap.

## After updating OMP

`omp-top` deliberately pins its OMP library dependencies to the installed OMP version. After upgrading OMP, rerun:

```bash
~/.local/share/omp-top/install.sh
```

## Custom OMP binary

```bash
OMP_TOP_OMP_BIN=/path/to/omp ./install.sh
```

If automatic version detection fails:

```bash
OMP_TOP_OMP_VERSION=18.3.1 ./install.sh
```

Use the version actually installed on your machine.

## Uninstall

```bash
~/.local/share/omp-top/uninstall.sh
```

## Security model

`omp-top` is intended to remain a small monitoring surface:

- it does not maintain a separate provider credential store;
- it does not implement OAuth flows;
- it does not expose a localhost HTTP server;
- it does not provide a shell/terminal execution UI;
- quota fetching is delegated to the installed OMP runtime;
- usage history is read through OMP's stats APIs.

## Development

```bash
bun install
bun test
bun run start
```

The package versions used for development should match the OMP version being tested.

## Status

Current release: **v0.3.0**.

This is an independent utility built around Oh My Pi's public package/API surface; it is not an official OMP project.
