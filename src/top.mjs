import { TerminalUI, Keys } from "./tui.mjs";
import { fetchStats } from "./omp.mjs";
import { normalizeStats, aggregateCacheByProvider, sortModels } from "./stats.mjs";
import { loadHistoricalQuota, mergeProviderReports, ProgressiveQuotaRefresh } from "./quota.mjs";
import {
  style, compactNumber, percent, providerLabel, usedFraction, quotaColor, cacheColor,
  progressBar, formatReset, formatClock, formatAge, visibleWidth, truncateAnsi,
} from "./format.mjs";

const STATUS_TTL_MS = 8000;
const DASHBOARD_MAX_WIDTH = 112;

function accountLabel(report, fallback) {
  const metadata = report?.metadata ?? {};
  for (const key of ["email", "accountId", "projectId", "orgName", "orgId"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}
function planLabel(report) {
  const metadata = report?.metadata ?? {};
  for (const key of ["planType", "plan", "tier"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sectionTitle(label, width, status = "") {
  const statusWidth = visibleWidth(status);
  const available = Math.max(6, width - label.length - statusWidth - (status ? 4 : 2));
  const ruleWidth = Math.max(6, Math.min(34, available));
  return `${style.bold(label)} ${style.dim("─".repeat(ruleWidth))}${status ? `  ${status}` : ""}`;
}

function statsStateText({ stats, refreshing, startedAt, updatedAt, error, now = Date.now() }) {
  const elapsed = startedAt ? formatAge(startedAt, now) : "0s";
  if (refreshing && !stats) return style.yellow(`↻ calculating · ${elapsed}`);
  if (refreshing && stats) return style.yellow(`↻ refreshing · ${elapsed} · showing previous`);
  if (error && stats) return style.red("⚠ refresh failed · showing previous");
  if (error) return style.red("⚠ unavailable");
  if (stats && updatedAt) return style.green(`✓ updated ${formatClock(updatedAt)}`);
  return style.dim("not loaded");
}

function renderStats(stats, width = 100, state = {}) {
  const status = statsStateText({ stats, ...state });
  const lines = [sectionTitle("REQUEST / CACHE", width, status)];
  if (!stats) {
    if (state.refreshing) {
      lines.push(style.dim("  Syncing OMP session history and calculating cache. First load may take a while."));
    } else if (state.error) {
      lines.push(style.red(`  ${String(state.error).slice(0, Math.max(20, width - 4))}`));
    } else {
      lines.push(style.dim("  Stats have not been loaded yet."));
    }
    return lines;
  }
  if (state.refreshing) lines.push(style.dim("  Showing the previous snapshot while the refresh runs."));
  else if (state.error) lines.push(style.dim("  Previous snapshot preserved; the latest refresh failed."));
  const o = stats.overall ?? {};
  lines.push(
    `  Requests      ${compactNumber(Number(o.totalRequests || 0)).padEnd(10)}  Cache rate      ${percent(Number(o.cacheRate || 0))}`,
    `  Input         ${compactNumber(Number(o.totalInputTokens || 0)).padEnd(10)}  Cache read      ${compactNumber(Number(o.totalCacheReadTokens || 0))}`,
    `  Output        ${compactNumber(Number(o.totalOutputTokens || 0)).padEnd(10)}  Cache write     ${compactNumber(Number(o.totalCacheWriteTokens || 0))}`,
    `  Errors        ${compactNumber(Number(o.failedRequests || 0)).padEnd(10)}  Cache savings   ${percent(Number(o.cacheSavings || 0))}`,
  );

  const providers = aggregateCacheByProvider(stats.byModel);
  if (providers.length) {
    lines.push("", sectionTitle("CACHE BY PROVIDER", width));
    lines.push(style.dim("  Provider                   Req      Hit       Read      Write"));
    for (const row of providers) {
      const name = providerLabel(row.provider).slice(0, 24).padEnd(24);
      const req = compactNumber(row.totalRequests).padStart(7);
      const hit = percent(row.cacheRate).padStart(7);
      const read = compactNumber(row.totalCacheReadTokens).padStart(9);
      const write = compactNumber(row.totalCacheWriteTokens).padStart(9);
      lines.push(`  ${name} ${req} ${cacheColor(row.cacheRate, hit)} ${read} ${write}`);
    }
  }

  const models = sortModels(stats.byModel);
  if (models.length) {
    lines.push("", sectionTitle("CACHE BY MODEL", width));
    lines.push(style.dim("  Provider             Model                             Req     Hit      Read     Write    Save"));
    for (const row of models) {
      const provider = providerLabel(String(row.provider ?? "unknown")).slice(0, 18).padEnd(18);
      const model = String(row.model ?? "unknown").slice(0, 32).padEnd(32);
      const req = compactNumber(Number(row.totalRequests || 0)).padStart(7);
      const rate = Number(row.cacheRate || 0);
      const hit = percent(rate).padStart(7);
      const read = compactNumber(Number(row.totalCacheReadTokens || 0)).padStart(8);
      const write = compactNumber(Number(row.totalCacheWriteTokens || 0)).padStart(8);
      const save = percent(Number(row.cacheSavings || 0)).padStart(7);
      lines.push(`  ${provider} ${model} ${req} ${cacheColor(rate, hit)} ${read} ${write} ${save}`);
    }
  }
  return lines;
}

function stateText(state, refreshing) {
  if (!state) return refreshing ? style.yellow("↻ refreshing") : "";
  const stamp = state.updatedAt ? ` · ${formatAge(state.updatedAt)} ago` : "";
  if (state.status === "fresh") return style.green(`✓ fresh${stamp}`);
  if (state.status === "refreshing") return style.yellow(`↻ refreshing${stamp ? ` · last ${formatClock(state.updatedAt)}` : ""}`);
  if (state.status === "error") return style.red(`⚠ stale${stamp}`);
  return style.dim(`stale${stamp}`);
}

function renderQuota(quota, width, providerStates, refreshing) {
  const reports = quota?.reports ?? [];
  const lines = [sectionTitle("QUOTA", width)];
  if (!reports.length) {
    lines.push(refreshing ? style.dim("  Waiting for quota results…") : style.dim("  No quota data available"));
    return lines;
  }
  const grouped = new Map();
  for (const report of reports) {
    const bucket = grouped.get(report.provider) ?? [];
    bucket.push(report);
    grouped.set(report.provider, bucket);
  }
  for (const provider of [...grouped.keys()].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)))) {
    const providerReports = grouped.get(provider) ?? [];
    lines.push("");
    const state = stateText(providerStates.get(provider), refreshing);
    lines.push(`  ${style.bold(providerLabel(provider))}${state ? `  ${state}` : ""}`);
    providerReports.sort((a, b) => accountLabel(a, "").localeCompare(accountLabel(b, ""))).forEach((report, index) => {
      const identity = accountLabel(report, providerReports.length > 1 ? `Account ${index + 1}` : "Account");
      const plan = planLabel(report);
      lines.push(`    ${style.cyan(identity)}${plan ? style.dim(` · ${plan}`) : ""}`);
      const limits = report.limits ?? [];
      if (!limits.length) { lines.push(style.dim("    no quota windows reported")); return; }
      for (const limit of limits) {
        const fraction = usedFraction(limit.amount ?? {});
        const label = String(limit.window?.label || limit.label || limit.id || "limit").slice(0, 22).padEnd(22);
        const barWidth = Math.max(6, Math.min(18, width - 50));
        const bar = progressBar(fraction, barWidth);
        const pct = percent(fraction).padStart(6);
        const reset = formatReset(limit.window?.resetsAt).padStart(13);
        lines.push(`      ${label} ${bar} ${quotaColor(fraction, pct)} ${reset}`.trimEnd());
      }
    });
  }
  return lines;
}

export class OmpTopApp {
  #redact;
  #ui;
  #done;
  #scroll = 0;
  #snapshot = { stats: undefined, quota: undefined, statsUpdatedAt: undefined, quotaUpdatedAt: undefined };
  #states = new Map();
  #status = "";
  #statusAt = 0;
  #statsRefreshing = false;
  #statsRefreshStartedAt;
  #statsError;
  #statsPulse;
  #quotaRefreshing = false;
  #quotaRun;
  #disposed = false;
  #deps;

  constructor({ redact = false, ui, deps = {} } = {}) {
    this.#redact = redact;
    this.#done = Promise.withResolvers();
    this.#deps = {
      fetchStats: deps.fetchStats ?? fetchStats,
      loadHistoricalQuota: deps.loadHistoricalQuota ?? loadHistoricalQuota,
      createQuotaRefresh: deps.createQuotaRefresh ?? (() => new ProgressiveQuotaRefresh()),
    };
    this.#ui = ui ?? new TerminalUI({ render: (w, h) => this.render(w, h), input: data => this.handleInput(data) });
  }

  async run() {
    this.#ui.start();
    void this.#bootstrap();
    return this.#done.promise;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#quotaRun?.cancel();
    if (this.#statsPulse) clearInterval(this.#statsPulse);
    this.#statsPulse = undefined;
    this.#ui.stop();
  }

  async #bootstrap() {
    try {
      const historical = await this.#deps.loadHistoricalQuota(this.#redact);
      if (historical.payload) {
        this.#snapshot.quota = historical.payload;
        this.#snapshot.quotaUpdatedAt = historical.payload.generatedAt;
        for (const report of historical.payload.reports ?? []) {
          const old = this.#states.get(report.provider);
          this.#states.set(report.provider, { status: "stale", updatedAt: Math.max(old?.updatedAt ?? 0, report.fetchedAt ?? 0) });
        }
        this.#ui.draw();
      }
    } catch {}
    void this.refresh();
  }

  setStatus(text) { this.#status = text; this.#statusAt = Date.now(); this.#ui.draw(); }

  async refresh() {
    if (!this.#statsRefreshing) {
      this.#statsRefreshing = true;
      this.#statsRefreshStartedAt = Date.now();
      this.#statsError = undefined;
      if (this.#statsPulse) clearInterval(this.#statsPulse);
      this.#statsPulse = setInterval(() => {
        if (!this.#disposed && this.#statsRefreshing) this.#ui.draw();
      }, 1000);
      this.#ui.draw();
      void this.#deps.fetchStats().then(raw => {
        if (this.#disposed) return;
        this.#snapshot.stats = normalizeStats(raw);
        this.#snapshot.statsUpdatedAt = Date.now();
        this.#statsError = undefined;
        this.setStatus(this.#quotaRefreshing ? "Stats refreshed · quota continues in background" : "Stats refreshed");
      }).catch(error => {
        if (!this.#disposed) {
          this.#statsError = String(error?.message || error);
          this.setStatus(style.yellow(`Stats refresh failed: ${this.#statsError}`));
        }
      }).finally(() => {
        this.#statsRefreshing = false;
        this.#statsRefreshStartedAt = undefined;
        if (this.#statsPulse) clearInterval(this.#statsPulse);
        this.#statsPulse = undefined;
        this.#ui.draw();
      });
    }
    if (!this.#quotaRefreshing) this.startQuotaRefresh();
  }

  startQuotaRefresh() {
    if (this.#quotaRefreshing || this.#disposed) return;
    this.#quotaRefreshing = true;
    for (const [provider, state] of this.#states) this.#states.set(provider, { ...state, status: "refreshing", error: undefined });
    const runner = this.#deps.createQuotaRefresh();
    this.#quotaRun = runner;
    this.setStatus("Refreshing quota progressively…");
    void runner.run(this.#redact, {
      onProvider: (provider, reports, updatedAt) => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quota = mergeProviderReports(this.#snapshot.quota, provider, reports);
        this.#snapshot.quotaUpdatedAt = Math.max(this.#snapshot.quotaUpdatedAt ?? 0, updatedAt);
        this.#states.set(provider, { status: "fresh", updatedAt });
        this.setStatus(`${providerLabel(provider)} quota updated · slower providers still refreshing`);
      },
      onComplete: payload => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quota = payload;
        this.#snapshot.quotaUpdatedAt = payload.generatedAt ?? Date.now();
        const live = new Set((payload.reports ?? []).map(report => report.provider));
        for (const provider of live) {
          const reports = (payload.reports ?? []).filter(report => report.provider === provider);
          const updatedAt = Math.max(...reports.map(report => report.fetchedAt ?? payload.generatedAt ?? Date.now()));
          this.#states.set(provider, { status: "fresh", updatedAt });
        }
        for (const [provider, state] of this.#states) if (!live.has(provider) && state.status === "refreshing") this.#states.set(provider, { ...state, status: "stale" });
        this.setStatus("Quota refresh complete");
      },
      onError: message => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        for (const [provider, state] of this.#states) if (state.status === "refreshing") this.#states.set(provider, { ...state, status: "error", error: message });
        this.setStatus(style.yellow(`Quota refresh ended with error: ${message}`));
      },
    }).finally(() => {
      if (this.#quotaRun !== runner) return;
      this.#quotaRun = undefined;
      this.#quotaRefreshing = false;
      for (const [provider, state] of this.#states) if (state.status === "refreshing") this.#states.set(provider, { ...state, status: "stale" });
      this.#ui.draw();
    });
  }

  handleInput(data) {
    if ([Keys.ctrlC, Keys.ctrlD, Keys.escape].includes(data) || data === "q") { this.#done.resolve(); return; }
    if (data === "r") { void this.refresh(); return; }
    if (data === "j" || data === Keys.down) this.#scroll += 1;
    else if (data === "k" || data === Keys.up) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (data === Keys.pageDown) this.#scroll += Math.max(1, this.#ui.rows - 5);
    else if (data === Keys.pageUp) this.#scroll = Math.max(0, this.#scroll - Math.max(1, this.#ui.rows - 5));
    else if (Keys.home.has(data)) this.#scroll = 0;
    else if (Keys.end.has(data)) this.#scroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#ui.draw();
  }

  render(width, height) {
    const dashboardWidth = Math.max(40, Math.min(width, DASHBOARD_MAX_WIDTH));
    const statsTime = formatClock(this.#snapshot.statsUpdatedAt);
    const quotaTime = formatClock(this.#snapshot.quotaUpdatedAt);
    const left = ` ${style.bold("OMP TOP")}${process.env.OMP_PROFILE ? style.dim(` · profile ${process.env.OMP_PROFILE}`) : ""}`;
    const right = style.dim(`stats ${statsTime} · quota ${quotaTime}`);
    const pad = Math.max(2, dashboardWidth - visibleWidth(left) - visibleWidth(right));
    const header = truncateAnsi(`${left}${" ".repeat(pad)}${right}`, dashboardWidth);

    const statsState = {
      refreshing: this.#statsRefreshing,
      startedAt: this.#statsRefreshStartedAt,
      updatedAt: this.#snapshot.statsUpdatedAt,
      error: this.#statsError,
    };
    const body = ["", ...renderStats(this.#snapshot.stats, dashboardWidth, statsState), "", ...renderQuota(this.#snapshot.quota, dashboardWidth, this.#states, this.#quotaRefreshing), ""];
    const footer = [
      truncateAnsi(style.dim("─".repeat(Math.max(1, dashboardWidth))), dashboardWidth),
      truncateAnsi(` ${Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : ""}`, dashboardWidth),
      truncateAnsi(style.dim(" r refresh · ↑/↓/j/k scroll · PgUp/PgDn · Home/End · q/Esc/Ctrl+D/Ctrl+C exit"), dashboardWidth),
    ];
    const bodyHeight = Math.max(1, height - 1 - footer.length);
    const maxOffset = Math.max(0, body.length - bodyHeight);
    if (this.#scroll === Number.MAX_SAFE_INTEGER) this.#scroll = maxOffset;
    this.#scroll = Math.max(0, Math.min(this.#scroll, maxOffset));
    const visible = body.slice(this.#scroll, this.#scroll + bodyHeight);
    while (visible.length < bodyHeight) visible.push("");
    return [header, ...visible, ...footer];
  }
}
