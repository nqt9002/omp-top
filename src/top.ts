import {
  ProcessTerminal,
  ScrollView,
  TUI,
  matchesKey,
  renderProgressBar,
  truncateToWidth,
  type Component,
} from "@oh-my-pi/pi-tui";
import { closeDb, type DashboardStats } from "@oh-my-pi/omp-stats";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { refreshStats, type StatsRefreshResult, type UsagePayloadJson, type UsageReportJson } from "./data";
import { aggregateCacheByProvider, sortModelsForCache } from "./cache";
import {
  ProgressiveQuotaRefresh,
  loadHistoricalQuota,
  mergeProviderReports,
  type QuotaProviderState,
} from "./quota";
import {
  accountLabel,
  formatCompactNumber,
  formatPercent,
  formatReset,
  providerLabel,
  resolveUsedFraction,
} from "./format";

interface Snapshot {
  stats?: DashboardStats;
  quota?: UsagePayloadJson;
  statsUpdatedAt?: number;
  quotaUpdatedAt?: number;
  syncedEntries?: number;
  syncedFiles?: number;
  statsError?: string;
  quotaError?: string;
}

const STATUS_TTL_MS = 8_000;

function formatClock(timestamp: number | undefined): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusColor(fraction: number | undefined, text: string): string {
  if (fraction === undefined) return chalk.dim(text);
  if (fraction >= 1) return chalk.red(text);
  if (fraction >= 0.8) return chalk.yellow(text);
  return chalk.green(text);
}

function cacheRateColor(fraction: number | undefined, text: string): string {
  if (fraction === undefined) return chalk.dim(text);
  if (fraction >= 0.8) return chalk.green(text);
  if (fraction >= 0.5) return chalk.yellow(text);
  return chalk.red(text);
}

function quotaBar(fraction: number | undefined, width: number): string {
  const safeWidth = Math.max(4, Math.min(22, width));
  return renderProgressBar(fraction, safeWidth, {
    min: 0,
    max: 1,
    showPercentage: false,
    style: {
      filled: "█",
      empty: "░",
      styleFilled: (value: string) => statusColor(fraction, value),
      styleEmpty: (value: string) => chalk.dim(value),
    },
  });
}

function metadataPlan(report: UsageReportJson): string {
  const metadata = report.metadata;
  if (!metadata) return "";
  for (const key of ["planType", "plan", "tier"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function renderStats(stats: DashboardStats | undefined): string[] {
  if (!stats) return [chalk.dim("  Stats unavailable")];
  const o = stats.overall;
  const lines = [
    chalk.bold("REQUEST / CACHE"),
    `  Requests      ${formatCompactNumber(o.totalRequests).padEnd(10)}  Cache rate      ${formatPercent(o.cacheRate)}`,
    `  Input         ${formatCompactNumber(o.totalInputTokens).padEnd(10)}  Cache read      ${formatCompactNumber(o.totalCacheReadTokens)}`,
    `  Output        ${formatCompactNumber(o.totalOutputTokens).padEnd(10)}  Cache write     ${formatCompactNumber(o.totalCacheWriteTokens)}`,
    `  Errors        ${formatCompactNumber(o.failedRequests).padEnd(10)}  Cache savings   ${formatPercent(o.cacheSavings)}`,
  ];

  const providerRows = aggregateCacheByProvider(stats.byModel);
  if (providerRows.length > 0) {
    lines.push("", chalk.bold("CACHE BY PROVIDER"));
    lines.push(chalk.dim("  Provider                  Req      Hit      Read       Write"));
    for (const row of providerRows) {
      const provider = providerLabel(row.provider).slice(0, 24).padEnd(24);
      const req = formatCompactNumber(row.totalRequests).padStart(7);
      const rate = formatPercent(row.cacheRate).padStart(7);
      const read = formatCompactNumber(row.totalCacheReadTokens).padStart(9);
      const write = formatCompactNumber(row.totalCacheWriteTokens).padStart(9);
      lines.push(`  ${provider} ${req} ${cacheRateColor(row.cacheRate, rate)} ${read} ${write}`);
    }
  }

  const modelRows = sortModelsForCache(stats.byModel);
  if (modelRows.length > 0) {
    lines.push("", chalk.bold("CACHE BY MODEL"));
    lines.push(chalk.dim("  Provider           Model                          Req      Hit      Read       Write    Save"));
    for (const row of modelRows) {
      const provider = providerLabel(row.provider).slice(0, 18).padEnd(18);
      const model = row.model.slice(0, 30).padEnd(30);
      const req = formatCompactNumber(row.totalRequests).padStart(7);
      const rate = formatPercent(row.cacheRate).padStart(7);
      const read = formatCompactNumber(row.totalCacheReadTokens).padStart(9);
      const write = formatCompactNumber(row.totalCacheWriteTokens).padStart(9);
      const savings = formatPercent(row.cacheSavings).padStart(7);
      lines.push(`  ${provider} ${model} ${req} ${cacheRateColor(row.cacheRate, rate)} ${read} ${write} ${savings}`);
    }
  }

  return lines;
}

function providerStateText(state: QuotaProviderState | undefined): string {
  if (!state) return "";
  const stamp = state.updatedAt ? ` ${formatClock(state.updatedAt)}` : "";
  switch (state.status) {
    case "fresh":
      return chalk.green(`✓ fresh${stamp}`);
    case "refreshing":
      return chalk.yellow(`↻ refreshing${stamp ? ` · last${stamp}` : ""}`);
    case "error":
      return chalk.red(`⚠ stale${stamp}`);
    default:
      return chalk.dim(`stale${stamp}`);
  }
}

function renderQuota(
  quota: UsagePayloadJson | undefined,
  width: number,
  states: ReadonlyMap<string, QuotaProviderState>,
  refreshing: boolean,
): string[] {
  if (!quota) {
    return [chalk.bold("QUOTA"), refreshing ? chalk.dim("  Waiting for first quota snapshot…") : chalk.dim("  Quota unavailable")];
  }
  const reports = quota.reports ?? [];
  if (reports.length === 0) {
    return [chalk.bold("QUOTA"), refreshing ? chalk.dim("  Refreshing provider quota…") : chalk.dim("  No provider usage reports")];
  }

  const grouped = new Map<string, UsageReportJson[]>();
  for (const report of reports) {
    const bucket = grouped.get(report.provider) ?? [];
    bucket.push(report);
    grouped.set(report.provider, bucket);
  }

  const lines: string[] = [chalk.bold("QUOTA")];
  for (const provider of [...grouped.keys()].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)))) {
    const providerReports = grouped.get(provider) ?? [];
    lines.push("");
    const state = providerStateText(states.get(provider));
    lines.push(`${chalk.bold(providerLabel(provider))}${state ? `  ${state}` : ""}`);
    providerReports
      .sort((a, b) => accountLabel(a.metadata, "").localeCompare(accountLabel(b.metadata, "")))
      .forEach((report, index) => {
        const fallback = providerReports.length > 1 ? `Account ${index + 1}` : "Account";
        const identity = accountLabel(report.metadata, fallback);
        const plan = metadataPlan(report);
        lines.push(`  ${chalk.cyan(identity)}${plan ? chalk.dim(` · ${plan}`) : ""}`);

        const limits = report.limits ?? [];
        if (limits.length === 0) {
          lines.push(chalk.dim("    no quota windows reported"));
          return;
        }
        for (const limit of limits) {
          const fraction = resolveUsedFraction(limit.amount ?? {});
          const pct = formatPercent(fraction).padStart(5);
          const reset = formatReset(limit.window?.resetsAt).padStart(12);
          const label = (limit.window?.label || limit.label || limit.id || "limit").slice(0, 22).padEnd(22);
          const barWidth = Math.max(6, Math.min(18, width - 50));
          const bar = quotaBar(fraction, barWidth);
          lines.push(`     ${label} ${bar} ${statusColor(fraction, pct)} ${reset}`.trimEnd());
        }
      });
  }
  return lines;
}

export class OmpTopComponent implements Component {
  readonly #ui: TUI;
  readonly #redact: boolean;
  readonly #done = Promise.withResolvers<void>();
  readonly #scroll = new ScrollView([], { height: 1 });
  #snapshot: Snapshot = {};
  #providerStates = new Map<string, QuotaProviderState>();
  #stats: string = "";
  #statusAt = 0;
  #statsRefreshing = false;
  #quotaRefreshing = false;
  #quotaRun: ProgressiveQuotaRefresh | undefined;

  constructor(ui: TUI, redact: boolean) {
    this.#ui = ui;
    this.#redact = redact;
  }

  run(): Promise<void> {
    // Show the latest durable quota immediately before any upstream network work.
    try {
      const historical = loadHistoricalQuota(this.#redact);
      if ((historical.reports?.length ?? 0) > 0) {
        this.#snapshot.quota = historical;
        this.#snapshot.quotaUpdatedAt = historical.generatedAt;
        for (const report of historical.reports ?? []) {
          const previous = this.#providerStates.get(report.provider);
          const updatedAt = Math.max(previous?.updatedAt ?? 0, report.fetchedAt ?? 0);
          this.#providerStates.set(report.provider, { status: "stale", updatedAt });
        }
      }
    } catch {
      // History is optional; live refresh can still populate the TUI.
    }
    this.#ui.requestRender();
    void this.#refresh();
    return this.#done.promise;
  }

  dispose(): void {
    this.#quotaRun?.cancel();
    this.#quotaRun = undefined;
    this.#scroll.dispose();
    closeDb();
  }

  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    const jobs: Promise<unknown>[] = [];
    if (!this.#statsRefreshing) {
      this.#statsRefreshing = true;
      jobs.push(
        refreshStats().then(next => {
          if (this.#disposed) return;
          this.#mergeStats(next);
          this.#statsRefreshing = false;
          const synced = typeof next.syncedEntries === "number" ? ` · ${next.syncedEntries} new entries` : "";
          if (next.error) this.#setStatus(chalk.yellow(`Stats refresh failed: ${next.error}`));
          else if (this.#quotaRefreshing) this.#setStatus(chalk.green(`Stats refreshed${synced}`) + chalk.dim(" · quota continues in background"));
          else this.#setStatus(chalk.green(`Stats refreshed${synced}`));
          this.#ui.requestRender();
        }),
     );
    }

    if (!this.#quotaRefreshing) this.#startQuotaRefresh();
    else if (!this.#statsRefreshing) this.#setStatus(chalk.dim("Quota refresh already running"));

    if (jobs.length > 0) await Promise.allSettled(jobs);
  }

  #startQuotaRefresh(): void {
    if (this.#quotaRefreshing || this.#disposed) return;
    this.#quotaRefreshing = true;
    this.#snapshot.quotaError = undefined;
    for (const [provider, state] of this.#providerStates) {
      this.#providerStates.set(provider, { ...state, status: "refreshing", error: undefined });
    }
    this.#setStatus("Refreshing quota progressively…");

    const runner = new ProgressiveQuotaRefresh();
    this.#quotaRun = runner;
    void runner.run(this.#redact, {
      onProvider: (provider, reports, updatedAt) => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quota = mergeProviderReports(this.#snapshot.quota, provider, reports);
        this.#snapshot.quotaUpdatedAt = Math.max(this.#snapshot.quotaUpdatedAt ?? 0, updatedAt);
        this.#providerStates.set(provider, { status: "fresh", updatedAt });
        this.#setStatus(chalk.green(`${providerLabel(provider)} quota updated`) + chalk.dim(" · slower providers still refreshing"));
        this.#ui.requestRender();
      },
      onComplete: payload => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quota = payload;
        this.#snapshot.quotaUpdatedAt = payload.generatedAt ?? Date.now();
        this.#snapshot.quotaError = undefined;
        const liveProviders = new Set((payload.reports ?? []).map(report => report.provider));
        for (const provider of liveProviders) {
          const reports = (payload.reports ?? []).filter(report => report.provider === provider);
          const updatedAt = Math.max(...reports.map(report => report.fetchedAt ?? payload.generatedAt ?? Date.now()));
          this.#providerStates.set(provider, { status: "fresh", updatedAt });
        }
        for (const [provider, state] of this.#providerStates) {
          if (!liveProviders.has(provider) && state.status === "refreshing") {
            this.#providerStates.set(provider, { ...state, status: "stale" });
          }
        }
        this.#setStatus(chalk.green("Quota refresh complete"));
        this.#ui.requestRender();
      },
      onError: message => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quotaError = message;
        for (const [provider, state] of this.#providerStates) {
          if (state.status === "refreshing") this.#providerStates.set(provider, { ...state, status: "error", error: message });
        }
        this.#setStatus(chalk.yellow(`Quota refresh ended with error: ${message}`));
        this.#ui.requestRender();
      },
    }).finally(() => {
      if (this.#quotaRun !== runner) return;
      this.#quotaRun = undefined;
      this.#quotaRefreshing = false;
      for (const [provider, state] of this.#providerStates) {
        if (state.status === "refreshing") this.#providerStates.set(provider, { ...state, status: "stale" });
      }
      this.#ui.requestRender();
    });
  }

  #mergeStats(next: StatsRefreshResult): void {
    this.#snapshot = {
      ...this.#snapshot,
      stats: next.stats ?? this.#snapshot.stats,
      statsUpdatedAt: next.statsUpdatedAt ?? this.#snapshot.statsUpdatedAt,
      syncedEntries: next.syncedEntries ?? this.#snapshot.syncedEntries,
      syncedFiles: next.syncedFiles ?? this.#snapshot.syncedFiles,
      statsError: next.error,
    };
  }

  #setStatus(text: string): void {
    this.#status = text;
    this.#statusAt = Date.now();
    this.#ui.requestRender();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "ctrl+d") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "escape") ||
      data === "q"
    ) {
      this.#done.resolve();
      return;
    }
    if (data === "r") {
      void this.#refresh();
      return;
    if (data === "j") this.#scroll.scroll(1);
    else if (data === "k") this.#scroll.scroll(-1);
    else if (!this.#scroll.handleScrollKey(data)) return;
    this.#ui.requestRender();
  }

  render(width: number): readonly string[] {
    const height = Math.max(8, this.#ui.terminal.rows);
    const statsTime = formatClock(this.#snapshot.statsUpdatedAt);
    const quotaTime = formatClock(this.#snapshot.quotaUpdatedAt);
    const left = ` ${chalk.bold("omp top")}${process.env.OMP_PROFILE ? chalk.dim(` · profile ${process.env.OMP_PROFILE}`) : ""}`;
    const active: string[] = [];
    if (this.#statsRefreshing) active.push("stats");
    if (this.#quotaRefreshing) active.push("quota");
    const right = active.length > 0 ? chalk.yellow(`refreshing ${active.join("+")}…`) : chalk.dim(`stats ${statsTime} · quota ${quotaTime}`);
    const pad = Math.max(1, width - Bun.stringWidth(left) - Bun.stringWidth(right) - 1);
    const header = truncateToWidth(`${left}${" ".repeat(pad)}${right}`, width);

    const status = Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : "";
    const footer = [
      truncateToWidth(` ${status}`, width),
      truncateToWidth(chalk.dim(" r refresh · ↑/↓/j/k scroll · PgUp/PgDn · Home/End · q/Esc/Ctrl+D/Ctrl+C exit"), width),
    ];
    const bodyHeight = Math.max(1, height - 1 - footer.length);

    const body: string[] = [];
    if (!this.#snapshot.stats && !this.#snapshot.quota && (this.#statsRefreshing || this.#quotaRefreshing)) {
      body.push("", chalk.dim(" Loading OMP stats and quota…"));
    } else {
      body.push("", ...renderStats(this.#snapshot.stats));
      if (this.#snapshot.statsError) body.push(chalk.yellow(`  stats: ${this.#snapshot.statsError}`));
      body.push("", ...renderQuota(this.#snapshot.quota, width, this.#providerStates, this.#quotaRefreshing));
      if (this.#snapshot.quotaError) body.push(chalk.yellow(`  quota: ${this.#snapshot.quotaError?`));
      body.push("");
    }

    this.#scroll.setLines(body);
    this.#scroll.setHeight(bodyHeight);
    const lines = [header, ...this.#scroll.render(width)];
    while (lines.length < height - footer.length) lines.push("");
    lines.push(...footer);
    return lines;
  }
}

export async function runOmpTop(redact: boolean): Promise<void> {
  const ui = new TUI(new ProcessTerminal());
  const component = new OmpTopComponent(ui, redact);
  const overlay = ui.showOverlay(component, {
    anchor: "top-left",
    width: "100%",
    maxHeight: "100%",
    margin: 0,
    fullscreen: true,
    mouseTracking: false,
  });
  ui.setFocus(component);
  ui.start();
  try {
    await component.run();
  } finally {
    component.dispose();
    overlay.hide();
    ui.stop();
  }
}
