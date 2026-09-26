import { TerminalUI, Keys } from "./tui.mjs";
import { fetchStats } from "./omp.mjs";
import { normalizeStats, aggregateCacheByProvider, sortModels } from "./stats.mjs";
import { loadHistoricalQuota, mergeProviderReports, ProgressiveQuotaRefresh } from "./quota.mjs";
import {
  style, compactNumber, percent, providerLabel, usedFraction, quotaColor, cacheColor,
  progressBar, formatReset, formatClock, formatAge, visibleWidth, truncateAnsi,
} from "./format.mjs";

const STATUS_TTL_MS = 8000;

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

function renderStats(stats) {
  if (!stats) return [style.dim("  Stats unavailable")];
  const o = stats.overall ?? {};
  const lines = [
    style.bold("REQUEST / CACHE"),
    `  Requests      ${compactNumber(Number(o.totalRequests || 0)).padEnd(10)}  Cache rate      ${percent(Number(o.cacheRate || 0))}`,
    `  Input         ${compactNumber(Number(o.totalInputTokens || 0)).padEnd(10)}  Cache read      ${compactNumber(Number(o.totalCacheReadTokens || 0))}`,
    `  Output        ${compactNumber(Number(o.totalOutputTokens || 0)).padEnd(10)}  Cache write     ${compactNumber(Number(o.totalCacheWriteTokens || 0))}`,
    `  Errors        ${compactNumber(Number(o.failedRequests || 0)).padEnd(10)}  Cache savings   ${percent(Number(o.cacheSavings || 0))}`,
  ];

  const providers = aggregateCacheByProvider(stats.byModel);
  if (providers.length) {
    lines.push("", style.bold("CACHE BY PROVIDER"));
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
    lines.push("", style.bold("CACHE BY MODEL"));
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
  const lines = [style.bold("QUOTA")];
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
    lines.push(`${style.bold(providerLabel(provider))}${state ? `  ${state}` : ""}`);
    providerReports.sort((a, b) => accountLabel(a, "").localeCompare(accountLabel(b, ""))).forEach((report, index) => {
      const identity = accountLabel(report, providerReports.length > 1 ? `Account ${index + 1}` : "Account");
      const plan = planLabel(report);
      lines.push(`  ${style.cyan(identity)}${plan ? style.dim(` · ${plan}`) : ""}`);
      const limits = report.limits ?? [];
      if (!limits.length) { lines.push(style.dim("    no quota windows reported")); return; }
      for (const limit of limits) {
        const fraction = usedFraction(limit.amount ?? {});
        const label = String(limit.window?.label || limit.label || limit.id || "limit").slice(0, 22).padEnd(22);
        const barWidth = Math.max(6, Math.min(18, width - 50));
        const bar = progressBar(fraction, barWidth);
        const pct = percent(fraction).padStart(6);
        const reset = formatReset(limit.window?.resetsAt).padStart(13);
        lines.push(`    ${label} ${bar} ${quotaColor(fraction, pct)} ${reset}`.trimEnd());
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
  #quotaRefreshing = false;
  #quotaRun;
  #disposed = false;

  constructor({ redact = false } = {}) {
    this.#redact = redact;
    this.#done = Promise.withResolvers();
    this.#ui = new TerminalUI({ render: (w, h) => this.render(w, h), input: data => this.handleInput(data) });
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
    this.#ui.stop();
  }

  async #bootstrap() {
    try {
      const historical = await loadHistoricalQuota(this.#redact);
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
      void fetchStats().then(raw => {
        if (this.#disposed) return;
        this.#snapshot.stats = normalizeStats(raw);
        this.#snapshot.statsUpdatedAt = Date.now();
        this.setStatus(this.#quotaRefreshing ? "Stats refreshed · quota continues in background" : "Stats refreshed");
      }).catch(error => {
        if (!this.#disposed) this.setStatus(style.yellow(`Stats refresh failed: ${error.message || error}`));
      }).finally(() => { this.#statsRefreshing = false; this.#ui.draw(); });
    }
    if (!this.#quotaRefreshing) instartQuotaRefresh();
  }

  startQuotaRefresh() {
    if (this.#quotaRefreshing || this.#disposed) return;
    this.#quotaRefreshing = true;
    for (const [provider, state] of this.#states) this.#states.set(provider, { ...state, status: "refreshing", error: undefined });
    const runner = new ProgressiveQuotaRefresh();
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
    const statsTime = formatClock(this.#snapshot.statsUpdatedAt);
    const quotaTime = formatClock(this.#snapshot.quotaUpdatedAt);
    const left = ` ${style.bold("omp top")}${process.env.OMP_PROFILE ? style.dim(` · profile ${process.env.OMP_PROFILE}`) : ""}`;
    const active = [this.#statsRefreshing ? "stats" : "", this.#quotaRefreshing ? "quota" : ""].filter(Boolean);
    const right = active.length ? style.yellow(`refreshing ${active.join("+")}…`) : style.dim(`stats ${statsTime} · quota ${quotaTime}`);
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    const header = truncateAnsi(`${left}${" ".repeat(pad)}${right}`, width);

    const body = ["", ...renderStats(this.#snapshot.stats), "", ...renderQuota(this.#snapshot.quota, width, this.#states, this.#quotaRefreshing), ""];
    const footer = [
      truncateAnsi(` ${Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : ""}`, width),
      truncateAnsi(style.dim(" r refresh · ↑/↓/j/k scroll · PgUp/PgDn · Home/End · q/Esc/Ctrl+D/Ctrl+C exit"), width),
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
