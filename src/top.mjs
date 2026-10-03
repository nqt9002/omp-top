import { TerminalUI, Keys } from "./tui.mjs";
import { fetchStats } from "./omp.mjs";
import { normalizeStats } from "./stats.mjs";
import { loadHistoricalQuota, mergeProviderReports, ProgressiveQuotaRefresh } from "./quota.mjs";
import { style, providerLabel, formatClock } from "./format.mjs";
import {
  composeSides, frameBottom, frameDivider, frameRow, frameTop, offsetLine, workspaceGeometry,
} from "./layout.mjs";
import { VIEWS, directViewIndex, nextViewIndex, renderView, renderViewTabs } from "./views.mjs";

const STATUS_TTL_MS = 8000;
const MAX_EVENTS = 60;

export class OmpTopApp {
  #redact;
  #version;
  #channel;
  #ui;
  #done;
  #viewIndex = 0;
  #scroll = 0;
  #snapshot = { stats: undefined, quota: undefined, statsUpdatedAt: undefined, quotaUpdatedAt: undefined };
  #states = new Map();
  #events = [];
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

  constructor({ redact = false, version = "", channel = "", ui, deps = {} } = {}) {
    this.#redact = redact;
    this.#version = version;
    this.#channel = channel;
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
    this.#pushEvent("info", "monitor started");
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

  #pushEvent(level, message) {
    this.#events.push({ at: Date.now(), level, message: String(message) });
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
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
        this.#pushEvent("info", "loaded historical quota snapshot and runway samples");
        this.#ui.draw();
      }
    } catch (error) {
      this.#pushEvent("warn", `historical quota unavailable: ${String(error?.message || error)}`);
    }
    void this.refresh();
  }

  setStatus(text) { this.#status = text; this.#statusAt = Date.now(); this.#ui.draw(); }

  async refresh() {
    if (!this.#statsRefreshing) {
      this.#statsRefreshing = true;
      this.#statsRefreshStartedAt = Date.now();
      this.#statsError = undefined;
      this.#pushEvent("info", "stats refresh started");
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
        this.#pushEvent("ok", `stats refreshed · ${this.#snapshot.stats.byModel.length} models`);
        this.setStatus(this.#quotaRefreshing ? "Stats refreshed · quota continues in background" : "Stats refreshed");
      }).catch(error => {
        if (!this.#disposed) {
          this.#statsError = String(error?.message || error);
          this.#pushEvent("error", `stats refresh failed: ${this.#statsError}`);
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
    this.#pushEvent("info", "quota refresh started");
    this.setStatus("Refreshing quota progressively…");
    void runner.run(this.#redact, {
      onProvider: (provider, reports, updatedAt) => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quota = mergeProviderReports(this.#snapshot.quota, provider, reports);
        this.#snapshot.quotaUpdatedAt = Math.max(this.#snapshot.quotaUpdatedAt ?? 0, updatedAt);
        this.#states.set(provider, { status: "fresh", updatedAt });
        this.#pushEvent("ok", `${providerLabel(provider)} quota updated`);
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
        this.#pushEvent("ok", `quota refresh complete · ${live.size} providers`);
        this.setStatus("Quota refresh complete");
      },
      onError: message => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        for (const [provider, state] of this.#states) if (state.status === "refreshing") this.#states.set(provider, { ...state, status: "error", error: message });
        this.#pushEvent("error", `quota refresh error: ${message}`);
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

  #switchView(index) {
    if (index === this.#viewIndex) return;
    this.#viewIndex = index;
    this.#scroll = 0;
    this.#ui.draw();
  }

  handleInput(data) {
    if ([Keys.ctrlC, Keys.ctrlD, Keys.escape].includes(data) || data === "q") { this.#done.resolve(); return; }
    if (data === "r") { void this.refresh(); return; }
    const direct = directViewIndex(data);
    if (direct !== undefined) { this.#switchView(direct); return; }
    if (data === Keys.tab || data === Keys.right) { this.#switchView(nextViewIndex(this.#viewIndex, 1)); return; }
    if (data === Keys.shiftTab || data === Keys.left) { this.#switchView(nextViewIndex(this.#viewIndex, -1)); return; }
    if (data === "j" || data === Keys.down) this.#scroll += 1;
    else if (data === "k" || data === Keys.up) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (data === Keys.pageDown) this.#scroll += Math.max(1, this.#ui.rows - 7);
    else if (data === Keys.pageUp) this.#scroll = Math.max(0, this.#scroll - Math.max(1, this.#ui.rows - 7));
    else if (Keys.home.has(data)) this.#scroll = 0;
    else if (Keys.end.has(data)) this.#scroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#ui.draw();
  }

  render(width, height) {
    const workspace = workspaceGeometry(width);
    const statsTime = formatClock(this.#snapshot.statsUpdatedAt);
    const quotaTime = formatClock(this.#snapshot.quotaUpdatedAt);
    const identity = [style.bold("OMP TOP")];
    if (this.#version) identity.push(`v${this.#version}`);
    if (this.#channel) identity.push(this.#channel);
    if (process.env.OMP_PROFILE) identity.push(`profile ${process.env.OMP_PROFILE}`);
    const title = identity.join(style.dim(" · "));

    const freshness = workspace.innerWidth >= 120
      ? style.dim(`stats ${statsTime} · quota ${quotaTime}`)
      : "";
    const tabs = renderViewTabs(this.#viewIndex, workspace.innerWidth);
    const navLine = composeSides(tabs, freshness, workspace.innerWidth);

    const statsState = {
      refreshing: this.#statsRefreshing,
      startedAt: this.#statsRefreshStartedAt,
      updatedAt: this.#snapshot.statsUpdatedAt,
      error: this.#statsError,
    };
    const view = VIEWS[this.#viewIndex] ?? VIEWS[0];
    const body = renderView(view.id, {
      stats: this.#snapshot.stats,
      statsState,
      quota: this.#snapshot.quota,
      providerStates: this.#states,
      quotaRefreshing: this.#quotaRefreshing,
      events: this.#events,
    }, workspace.innerWidth);

    const bodyHeight = Math.max(1, height - 7);
    const maxOffset = Math.max(0, body.length - bodyHeight);
    if (this.#scroll === Number.MAX_SAFE_INTEGER) this.#scroll = maxOffset;
    this.#scroll = Math.max(0, Math.min(this.#scroll, maxOffset));
    const visible = body.slice(this.#scroll, this.#scroll + bodyHeight);
    while (visible.length < bodyHeight) visible.push("");

    const activeStatus = Date.now() - this.#statusAt < STATUS_TTL_MS && this.#status
      ? this.#status
      : style.dim(`${view.label} · ready`);
    const scrollState = maxOffset > 0
      ? style.dim(`scroll ${this.#scroll + 1}/${maxOffset + 1}`)
      : style.dim("fit");
    const statusLine = composeSides(activeStatus, scrollState, workspace.innerWidth);
    const hints = workspace.mode === "compact"
      ? "1–6 view · Tab switch · r refresh · ↑↓ scroll · q exit"
      : "1–6 view · Tab/Shift+Tab/←→ switch · r refresh · ↑↓/j/k scroll · PgUp/PgDn · q/Esc exit";

    const framed = [
      frameTop(workspace.width, title),
      frameRow(navLine, workspace.width),
      frameDivider(workspace.width),
      ...visible.map(line => frameRow(line, workspace.width)),
      frameDivider(workspace.width),
      frameRow(statusLine, workspace.width),
      frameRow(style.dim(hints), workspace.width),
      frameBottom(workspace.width),
    ];
    return framed.map(line => offsetLine(line, workspace.offset));
  }
}
