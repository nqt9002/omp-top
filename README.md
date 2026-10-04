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

Clone the GitHub repository once:

```bash
git clone https://github.com/nqt9002/omp-top.git
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

### Keyboard controls

| Key | Action |
| --- | --- |
| `1`–`6` | Open Overview / Quota / Models / Cache / Agents / Events |
| `Tab`, `→` | Next view |
| `Shift+Tab`, `←` | Previous view |
| `r` | Refresh stats and quota |
| `↑` / `↓`, `j` / `k` | Scroll current view |
| `PgUp` / `PgDn` | Page scroll |
| `Home` / `End` | Jump to top/bottom |
| `q` / `Esc` | Exit |
| `Ctrl+C` / `Ctrl+D` | Exit |

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
omp-top upgrade --tag v0.5.1
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

After `omp stats --json` finishes syncing session statistics, omp-top opens OMP's `stats.db` **read-only** and aggregates the same 24-hour decision window used by the default stats command.

The diagnostic layer treats OMP's `input_tokens` column as uncached input because OMP stores cache-read tokens separately. This makes it possible to identify whether uncached input is concentrated in a particular model, agent type, project, or session without reading prompt contents.

Cache alerts are impact-based rather than hit-rate-only. A high-volume model can therefore be surfaced when it owns a large share of uncached input even if that model drags its provider average down and would otherwise mask itself.

Likely contributors such as subagent concentration, one dominant project/session, large uncached input per request, or poor reuse compared with sibling models are explicitly presented as diagnostics to investigate — not as proven causes of a cache miss.

If `stats.db` is unavailable or its schema changes, omp-top falls back to the normal aggregate cache statistics.

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
- OMP's current 24h stats expose aggregate cache efficiency but not a historical cache-rate series, so omp-top can flag low cache and correlate it with quota pressure, but does not claim a cache-rate trend unless the source data supports one.
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

Bug fixes and features should link their PR with `Fixes #<issue>`.

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

Docs-only changes do not need a release-line change.

## Current development line

**0.6.0 · beta**

## License

MIT

---

`omp-top` is an independent utility built around OMP's CLI contracts. It is not an official Oh My Pi project.
