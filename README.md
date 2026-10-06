# omp-top

A small terminal monitor for **Oh My Pi (OMP)** request/cache statistics and provider quota.

`omp-top` is intentionally independent from OMP's internal npm packages. It talks to the installed `omp` CLI and uses Bun's built-in APIs, so normal OMP upgrades do **not** require reinstalling `omp-top`.

## What it shows

- Actionable Overview intelligence that ranks quota, model reliability, cache, workload, and runtime anomalies before showing routine context.
- Cross-domain decision support: quota runway/burn acceleration, low-cache signals, request-volume pressure, model failures, agent concentration, and recent runtime errors.
- Overall request and token usage.
- Cache hit rate, cache read/write tokens, and cache savings.
- Cache breakdown by provider.
- Multi-view TUI: Overview, Quota, Models, Cache, Agents, and Events.
- Cache breakdown by provider and exact model.
- Request-level cache diagnostics from OMP's local `stats.db`: uncached input by model, agent, project, session, and hourly bucket.
- Model performance when OMP reports it: errors, TTFT, latency, tokens/sec, and API-equivalent cost.
- Provider/account quota with burn rate, recent-vs-baseline acceleration, exhaustion ETA, sustainable pace, reset countdown, and reset-aware risk state.
- Google Antigravity quota is split into its Gemini pool and the shared Claude/GPT third-party pool.
- Progressive quota updates: faster providers appear first while slower providers continue refreshing.
- Last-known quota while a live refresh is still running.
- In-memory runtime event feed for refresh progress and failures.

## Requirements

- OMP installed and available as `omp`.
- Bun `>= 1.3.14`.
- macOS, Linux, or another Unix-like environment supported by Bun and OMP.

## Install

Clone the stable release once:

```bash
git clone --branch v0.6.0 --depth 1 https://github.com/nqt9002/omp-top.git
cd omp-top
./install.sh
```

The installer places:

```text
~/.local/bin/omp-top
~/.local/share/omp-top
```

If `~/.local/bin` is not already in your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

After the first installation, you do not need to clone the repository again to upgrade.

## Use

Start the monitor:

```bash
omp-top
```

Useful commands:

```bash
omp-top --version
omp-top --profile work
omp-top --redact
omp-top --quota-timeout 30000
```

### Automatic refresh

omp-top refreshes itself by default with conservative fixed cadences:

- **Stats / cache diagnostics:** every 60 seconds. These are local OMP statistics and do not poll provider quota APIs.
- **Quota:** every 5 minutes, matching OMP 18.6.0's built-in usage-report cache TTL.
- **Countdown redraw:** once per second for the UI only; it does not fetch any data.

The header uses countdowns only, so every live timer moves in the same direction:

```
stats ↻42s · quota ↻3m
```

Quota reset, ETA and saved-credit expiry timers follow the same countdown convention. Once a deadline is reached, omp-top shows a fixed due state instead of switching to an elapsed "ago" counter.

Press `r` for an immediate normal refresh. Manual refresh still respects OMP's own provider usage cache; omp-top does **not** automatically invalidate that cache.

The quota interval is intentionally not user-configurable. Very aggressive provider usage polling can create unnecessary upstream load and may trigger provider rate limits, so omp-top follows OMP's own cache cadence instead.

## Keyboard controls

| Key | Action |
| --- | --- |
| `1`–`6` | Open Overview / Quota / Models / Cache / Agents / Events |
| `Tab`, `→` | Next view |
| `Shift+Tab`, `←` | Previous view |
| `r` | Refresh stats and quota |
| `Enter` | Inspect rows; follow a selected alert, model, or project |
| `/` | Search rows (Enter applies, Esc cancels, Ctrl+U clears) |
| `s` / `f` | Cycle sorting / provider filter while inspecting |
| `c` / `b` | Clear search/provider filter / return from drill-down |
| `w` | Cycle local statistics window: 1h / 6h / 24h |
| `v` | Toggle previous-window comparison |
| `n` | Toggle local quota notifications (default off) |
| `?` | Show interaction help |
| `↑` / `↓`, `j` / `k` | Scroll dashboard, or select a row while inspecting |
| `PgUp` / `PgDn` | Page dashboard/comparison, or scroll full row detail |
| `Home` / `End` | Jump to top/bottom |
| `q` / `Esc` | Exit; Esc first cancels search or returns from comparison/inspection |
| `Ctrl+C` / `Ctrl+D` | Exit |

### Terminal layout

The workspace follows the terminal width instead of centering a fixed 160-column canvas. Layout responds to terminal columns and rows, rather than display pixels.

- At 180 columns or wider and 24 rows or taller, views use a bounded main reading area plus a contextual panel. Overview separates actionable signals from system context; Cache separates aggregate tables from diagnostics. Other views keep related signals alongside their primary data.
- Smaller or shorter terminals use a single reading area. Very short terminals reduce header decoration to leave room for content.
- Navigation and refresh countdowns occupy separate rows, keeping all six view shortcuts accessible in English and Vietnamese.
- Long quota labels, alert text and event messages wrap instead of losing their ends. Model table cells still use ellipses when identifiers exceed their column width.
- Press `Enter` to inspect rows: arrows select a row, PgUp/PgDn scroll its full detail, and Escape returns to the dashboard. Selection persists across view switches and resize.
- Switching views restores each view's scroll position. Page scrolling follows the current viewport height.

The renderer coalesces redraw requests and writes only changed terminal rows; unchanged frames produce no terminal output. Resize triggers a full repaint. Synchronized output is used where the terminal supports it, and cursor/wrap/paste modes are restored on exit.

Arrow keys and navigation sequences are decoded across input chunks, including held-key bursts. Bracketed paste is accepted as text only while editing a search; it never runs dashboard shortcuts. A standalone Escape is recognized after a short disambiguation delay so a fragmented arrow sequence is not mistaken for Exit.

### Search and drill-down

Press `Enter` to inspect the current view. Full model/account/project/session identifiers remain available in the detail area even when the row list shortens them. Enter on an Overview alert selects its provider/model or exact quota account/bucket. Models and Cache model rows lead to projects, and project rows lead to sessions. `b` restores the previous selection and query.

`/` accepts free text and field filters, combined with AND:

```text
provider:openai-codex model:gpt
project:"/workspace/project with spaces" session:session-id
agent:worker
```

`f` cycles the available providers. `s` cycles source order, name, requests, and usage; usage means quota fraction for quota rows or uncached/input tokens for workload rows. These controls filter the inspection list, not the profile-wide comparison. Missing local project/session diagnostics are reported explicitly.

### Time windows and comparison

`w` cycles 1h, 6h, and 24h (default). Window reads use timestamped `stats.db` request records with exact half-open bounds `[start, end)`, not quota snapshots. They do not trigger additional provider quota polls.

When local records are available, request/cache metrics and attribution follow the selected window. OMP's default-24h error/latency/cost metrics remain accessible in model detail as a separately labeled aggregate; they are not attributed to a 1h/6h local window. Missing fields display as unavailable rather than invented zeros. At 24h, OMP aggregate statistics remain a labeled fallback if local window reads fail; a failed 1h/6h read never substitutes a 24h aggregate.

`v` compares recorded request counts and input/cache tokens against the preceding equal-duration window. Comparison requires valid counters and local records extending to the previous start. It describes **observed local records only**: the oldest record does not prove continuous ingestion or complete provider activity. A zero previous baseline does not produce a percentage change. Comparison covers the whole profile; inspection searches/provider filters do not change it.

Quota always remains the current provider snapshot. Choosing a stats window does not invent quota history or reassign shared quota usage to a model/session.

### Local quota notifications

Notifications are **off by default** and opt-in for the current process:

```bash
omp-top --notify
```

Alternatively, press `n` while running. A new fresh at-risk/exhausted quota observation adds a local Events entry and emits the terminal bell (audibility depends on the terminal). No desktop service, webhook, email, or other external destination is invoked.

The policy rejects stale/future/unknown timestamps, failed or refreshing providers, expired resets, and unsupported historical forecasts. Repeated observations are deduplicated by account/bucket and cycle; a healthy recovery or severity escalation permits a subsequent alert. Toggling on does not replay the previously displayed snapshot, and bootstrap history does not notify. Deduplication is in memory for the current process; no account identifiers are persisted for notifications.

## Language

English is the default UI language. Vietnamese is bundled with the release and can be enabled persistently without installing a separate package:

```bash
omp-top language vi
```

Switch back to English:

```bash
omp-top language en
```

Show the active language and supported locales:

```bash
omp-top language
```

The preference is stored outside the installed release under `$XDG_CONFIG_HOME/omp-top/config.json` or `~/.config/omp-top/config.json`, so upgrading or switching stable/beta does not reset it.

For a one-process override, useful for testing:

```bash
OMP_TOP_LANG=vi omp-top
OMP_TOP_LANG=en omp-top
```

Provider names, model IDs, agent IDs, TTFT/TPS and other technical identifiers are kept unchanged; surrounding labels, statuses, help text and guidance are localized.

## Upgrade omp-top

Upgrade directly from **GitHub Releases**:

```bash
omp-top upgrade
```

The upgrade flow is:

```text
GitHub Releases API
        ↓
latest stable release
        ↓
tar.gz + SHA256
        ↓
checksum + archive validation
        ↓
Bun source validation
        ↓
atomic install
```

No npm registry, npx, or bunx is involved.

Install one exact release:

```bash
omp-top upgrade --tag v0.6.0
```

Install the newest published beta:

```bash
omp-top upgrade --channel beta
```

Channel selection is per command and is not sticky. Stable v0.5.4 and newer understand the channel interface directly:

```bash
omp-top upgrade --channel beta
omp-top upgrade --channel stable
```

Exact `--tag` remains available for recovery or intentional rollback.

Release assets are published as:

```text
omp-top-vX.Y.Z.tar.gz
omp-top-vX.Y.Z.tar.gz.sha256
```

## Updating OMP

OMP and `omp-top` have separate lifecycles.

Update OMP normally:

```bash
omp update
```

You do **not** need to reinstall or upgrade `omp-top` just because OMP changed version.

Update `omp-top` only when `omp-top` itself has a new release:

```bash
omp-top upgrade
```

## How it works

### Overview intelligence

Overview is intentionally not a duplicate of the detail tabs. It surfaces the highest-value signals first and points to the relevant drill-down view.

Examples include:

- a provider quota likely to exhaust before reset;
- quota burn running materially faster than its reset-aware historical baseline;
- low cache efficiency on a model/provider with meaningful cache activity;
- request failures weighted by both error rate and sample size;
- elevated request volume that coincides with faster quota burn;
- dominant agent/role token share and recent omp-top runtime errors.

For shared provider quota pools, omp-top does **not** claim that one model consumed a measured share of quota unless OMP supplies a model-scoped quota. It may show a dominant model as workload attribution (for example, 80% of that provider's requests) and labels this as inference rather than direct quota accounting.

Likewise, cache/request correlations are phrased as possible contributors, not causes. Quota reset timestamps are shown as resets; they are not described as subscription renewal dates unless a provider explicitly exposes billing-renewal metadata.

### Stats and cache

`omp-top` runs:

```bash
omp stats --json
```

OMP performs its own session sync and returns normalized dashboard data. `omp-top` renders the overall and per-model data.

Provider cache hit rate is calculated from summed token counters:

```text
cache read / (uncached input + cache read)
```

This avoids averaging model percentages incorrectly.

### Cache diagnostics

After `omp stats --json` finishes syncing session statistics, omp-top opens OMP's `stats.db` **read-only**. The window reader aggregates the selected 1h/6h/24h range within one read transaction, preserving complete project/session attribution. It validates required token counters; incomplete or invalid current counters make the window unavailable, and invalid previous counters disable comparison only. The original 24h diagnostics remain a fallback when the window reader is unavailable.

The diagnostic layer treats OMP's `input_tokens` column as uncached input because OMP stores cache-read tokens separately. This makes it possible to identify whether uncached input is concentrated in a particular model, agent type, project, or session without reading prompt contents.

Cache alerts are impact-based rather than hit-rate-only. A high-volume model can therefore be surfaced when it owns a large share of uncached input even if that model drags its provider average down and would otherwise mask itself.

Likely contributors such as subagent concentration, one dominant project/session, large uncached input per request, or poor reuse compared with sibling models are explicitly presented as diagnostics to investigate — not as proven causes of a cache miss.

If `stats.db` is unavailable or its schema changes, omp-top falls back to the normal aggregate cache statistics.

### Quota view density

The Quota tab is anomaly-first:

- a healthy quota bucket normally occupies one line;
- a second burn/ETA/safe-pace line appears only when the bucket is exhausted, at risk, on watch, or materially accelerating;
- zero/no-signal intelligence rows are suppressed;
- Google Antigravity group/window combinations are flattened into dense labels such as `Gemini Weekly` and `Claude & GPT (shared) 5 Hour`;
- the global quota refresh countdown appears once in the header instead of being repeated per provider;
- `↻` is reserved for refresh countdowns; quota reset and ETA values remain countdowns without the refresh glyph.

Provider-specific bucket identity and absolute-unit details remain intact.

### Quota provider coverage

omp-top mirrors the normalized quota buckets emitted by OMP instead of maintaining a separate provider-specific scraper. Semantic `UsageLimit.label` values are preserved, so model/tier/feature counters that share the same time window remain distinguishable.

| OMP provider | Quota detail preserved by omp-top |
| --- | --- |
| OpenAI Codex | primary/secondary windows, Spark/additional limits, saved reset credits |
| Anthropic | 5h + shared 7d plus Opus/Sonnet/Fable/Mythos scoped weekly counters when OMP reports them |
| Google Antigravity | Google/Anthropic/OpenAI backend counters, tiers and daily/weekly windows; only duplicate shared upstream counters are deduped |
| Google Gemini CLI | every modelId quota bucket and current plan/tier |
| GitHub Copilot | Premium, Chat, Completions and billing model rows, including Unlimited/overage notes |
| ZAI | token, request and Web Search/Reader/Zread feature quotas |
| OpenCode Go | rolling 5h, weekly and monthly OMP-observed spend, including absolute USD amounts |
| Kimi Code | total quota and provider-supplied limit/window rows |
| Cursor | request/model and spend limits returned by Cursor |
| Ollama | no standalone quota API; omp-top shows OMP's explanatory provider note |
| Ollama Cloud | no standalone quota API; omp-top shows OMP's explanatory provider note |

MiniMax's OMP usage module currently has no quota API implementation and is not registered in OMP's default usage-provider list, so omp-top does not invent a quota value for it.

Quota rendering follows OMP's own title semantics: provider-defined limit label first, then tier/window only when they add information. Absolute units (USD/tokens/requests/minutes/bytes), provider/limit notes and reset-credit metadata are shown when OMP includes them.

### Quota

A single background process runs:

```bash
omp usage --json
```

OMP remains responsible for credentials, OAuth refresh, provider retries, and usage normalization.

While that command is still running, `omp-top` opens the active profile's `agent.db` **read-only** with `bun:sqlite` and watches OMP's `usage_history` snapshots.

That allows progressive rendering:

```text
Codex completes  ──> render now
Gemini completes ──> render now
Claude completes later ──> render later
```

If local usage history is unavailable or its schema changes, progressive updates are skipped and `omp-top` falls back to the final `omp usage --json` result.

### Profiles

With:

```bash
omp-top --profile work
```

`OMP_PROFILE=work` is inherited by OMP subprocesses. `omp config path` is used to locate the matching profile's `agent.db`.

## Architecture

```text
                    omp-top
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
 omp stats --json  omp usage --json  bun:sqlite
          │            │            │
          │            └──── usage_history
          │
          └──── request/cache data
```

Runtime dependencies:

```text
@oh-my-pi/* packages   0
third-party npm deps   0
OMP executable         required
Bun built-ins          used
```

## Security model

- Provider credentials remain owned by OMP.
- `omp-top` does not implement OAuth or token refresh.
- `agent.db` is opened read-only for progressive quota history.
- `stats.db` is opened read-only for request-level cache diagnostics.
- No localhost web server is exposed.
- No Electron/browser runtime is used.
- No arbitrary shell execution interface is exposed.
- Upgrades only install versioned assets from this repository's GitHub Releases after SHA256 verification and source validation.

Optional environment variables:

```text
OMP_TOP_OMP_BIN        custom omp executable
OMP_TOP_HOME           custom install directory
OMP_TOP_BIN_DIR        custom launcher directory
OMP_TOP_GITHUB_TOKEN   optional token for GitHub API rate limits
OMP_TOP_GITHUB_REPO    alternate release repository for development/testing
OMP_TOP_LANG           one-process UI locale override: en or vi
OMP_TOP_STATS_DB       optional stats.db override for diagnostics/testing
```

## Limitations

- Cache statistics are available by provider/model, not by individual OAuth account, because OMP session stats do not carry a stable credential identity.
- Shared quota history usually does not identify the exact model that consumed quota. Overview therefore distinguishes direct model-scoped quota from inferred dominant workload.
- Local request/cache comparisons require compatible timestamped `stats.db` records. They do not establish continuous collection, complete account activity, or quota history. A partial window is never extrapolated into a full baseline trend.
- Progressive quota depends on local `usage_history`. Auth-broker setups that do not maintain local history may only show the final quota result.
- `omp-top` depends on OMP's user-facing JSON CLI contracts. If those contracts change incompatibly, `omp-top` may need an update.

## Uninstall

```bash
omp-top uninstall
```

## Development

There are no npm dependencies.

Run validation and tests:

```bash
bun run check
bun test/run.mjs
node --test test/*.test.mjs
```

### Contribution workflow

Changes follow an issue-first workflow:

```text
GitHub Issue
    ↓
dedicated branch
    ↓
implementation + tests
    ↓
Pull Request
    ↓
CI gate
    ↓
merge
```

Bug fixes and features target `develop` from a dedicated branch and reference their tracking issue with `Refs #<issue>`. Release, hotfix, and documentation PRs may target `main`; use `Fixes #<issue>` when that merge completes the tracked work. PR titles use Conventional Commit prefixes.

### Releases

`main` is the stable branch and `develop` is the beta/integration branch.

`package.json.version` stores the **release line** only, for example `0.6.0`. It is not used as a beta counter. The source channel is declared separately.

For beta releases:

```text
accepted PR → develop
        ↓
checked-release tests
        ↓
scan existing releases + Git tags for 0.6.0-beta.N
        ↓
publish the next sequence
v0.6.0-beta.1 → beta.2 → beta.3 → ...
```

The numeric suffix counts **published beta checkpoints**, not commits or PR numbers. Draft releases and existing tags reserve their sequence so tags are never reused.

For stable releases:

```text
tested beta
    ↓
release PR / approved promotion → main
    ↓
verify the tested beta has the same release line and runtime
    ↓
publish v0.6.0 as the stable/Latest release
```

Each release reruns runtime validation and tests, packages only tracked release files, generates an exact `release-manifest.json` inside the archive, verifies SHA256, smoke-tests the packaged CLI, and only then publishes the GitHub Release. Re-running a source commit that was already released is idempotent.

`workflow_dispatch` remains available as a recovery/admin path; normal beta and stable publishing is driven by accepted merges to their channel branches.

Docs-only changes do not need a release-line change. Normal publication is path-filtered; a documentation-only merge does not trigger a release.

For stable promotion, branch from the exact tested beta, set `package.json.releaseChannel` to `stable`, and retain the beta's runtime and ancestry. Review and pass PR CI before merging the release PR to `main`. The checked workflow verifies the same runtime against the published beta and refuses reused tags; no manual tag push is needed.

## Current release

**0.6.0 · stable**

Promoted from the maintainer-tested [v0.6.0-beta.16](https://github.com/nqt9002/omp-top/releases/tag/v0.6.0-beta.16). See [release notes](https://github.com/nqt9002/omp-top/blob/v0.6.0/CHANGELOG.md) for the stable highlights and validation.

## License

MIT

---

`omp-top` is an independent utility built around OMP's CLI contracts. It is not an official Oh My Pi project.
