# Changelog

## 0.6.0 — 2026-10-06

Stable promotion of [v0.6.0-beta.16](https://github.com/nqt9002/omp-top/releases/tag/v0.6.0-beta.16), tested by the maintainer. The runtime is unchanged from beta.16.

### Highlights

- Six views: actionable Overview, dense Quota, Models, Cache, Agents, and Events, with English and Vietnamese interfaces.
- Responsive terminal layout, row inspection, search, provider filters, sorting, and model → project → session drill-down.
- Local 1h/6h/24h request/cache windows and previous-window comparison with explicit incomplete-data limits.
- Conservative automatic refresh, reset countdowns, quota risk signals, and opt-in local terminal-bell notifications.
- Diff-based rendering and coalesced redraws, preserved navigation state, fragmented-key decoding, and bracketed-paste isolation.
- Stable/beta channel upgrades with checked release assets, SHA256 verification, and exact release manifests.

### Install and upgrade

Follow the [installation guide](README.md#install). Existing installations can run `omp-top upgrade --channel stable` or pin `omp-top upgrade --tag v0.6.0`. Beta selection remains explicit with `--channel beta`; it is not sticky. Language preferences survive upgrades.

### Validation and provenance

- Tested beta source: `ea68c9ebbdf32d3056cc283878f8ed4e4255ee3c`.
- [Promotion issue #51](https://github.com/nqt9002/omp-top/issues/51) and [release PR #52](https://github.com/nqt9002/omp-top/pull/52) record the promotion and CI evidence.
- The checked stable workflow reruns syntax checks, Bun build/runtime tests, Node regression tests, archive checksum/manifest checks, and packaged `--help`/`--version` smoke checks before publication.

Quota remains a current provider snapshot; local time-window comparisons do not establish continuous collection or invent quota history. Notifications are local and off by default. See [limitations](README.md#limitations).
