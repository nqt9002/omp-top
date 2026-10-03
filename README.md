# omp-top

A small terminal monitor for **Oh My Pi (OMP)** request/cache statistics and provider quota.

`omp-top` is intentionally independent from OMP's internal npm packages. It talks to the installed `omp` CLI and uses Bun's built-in APIs, so normal OMP upgrades do **not** require reinstalling `omp-top`.

## What it shows

- Overall request and token usage.
- Cache hit rate, cache read/write tokens, and cache savings.
- Cache breakdown by provider.
- Multi-view TUI: Overview, Quota, Models, Cache, Agents, and Events.
- Cache breakdown by provider and exact model.
- Model performance when OMP reports it: errors, TTFT, latency, tokens/sec, and API-equivalent cost.
- Provider/account quota with burn rate, exhaustion ETA, sustainable pace, and reset-aware risk state.
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

Channel selection is per command and is not sticky. If upgrading directly from the old v0.5.3 stable build, use the exact-tag command once:

```bash
omp-top upgrade --tag v0.6.0-beta.1
```

After that, use `omp-top upgrade --channel beta` for later beta checkpoints.

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
```

## Limitations

- Cache statistics are available by provider/model, not by individual OAuth account, because OMP session stats do not carry a stable credential identity.
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
