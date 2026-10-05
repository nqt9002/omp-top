import { loadRequestWindow } from './request-windows.mjs';
import { QuotaAlertPolicy } from './quota-alerts.mjs';
import { renderComparison, windowSummary } from './window-view.mjs';
import { exploreEntries, SORT_ORDERS } from './exploration.mjs';
import { renderInspection } from './inspection.mjs';
import { TerminalUI, Keys } from "./tui.mjs";
import { fetchStats } from "./omp.mjs";
import { normalizeStats } from "./stats.mjs";
import { loadHistoricalQuota, mergeProviderReports, ProgressiveQuotaRefresh } from "./quota.mjs";
import { style, providerLabel, formatCountdown } from "./format.mjs";
import {
  composeSides, frameBottom, frameDivider, frameRow, frameTop, offsetLine, workspaceGeometry, wrapLines,
} from "./layout.mjs";
import { VIEWS, directViewIndex, nextViewIndex, renderWorkspace, renderViewTabs, viewLabel } from "./views.mjs";
import { t } from "./i18n.mjs";
import { loadCacheDiagnostics } from "./cache-diagnostics.mjs";
import {
  COUNTDOWN_REDRAW_MS, QUOTA_AUTO_REFRESH_MS, STATS_AUTO_REFRESH_MS, nextRefreshAt,
} from "./refresh-policy.mjs";

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
  #scrollByView = new Map();
  #bodyHeight = 1;
  #inspecting = false;
  #inspectionByView = new Map();
  #entries = [];
  #providers = [];
  #searchDraft;
  #history = [];
  #windowHours = 24;
  #requestWindow;
  #windowLoading = false;
  #windowRun = 0;
  #comparisonOpen = false;
  #alerts = new QuotaAlertPolicy();
  #snapshot = { stats: undefined, quota: undefined, cacheDiagnostics: undefined, statsUpdatedAt: undefined, quotaUpdatedAt: undefined };
  #states = new Map();
  #events = [];
  #status = "";
  #statusAt = 0;
  #statsRefreshing = false;
  #statsRefreshStartedAt;
  #statsError;
  #quotaRefreshing = false;
  #quotaRun;
  #statsAutoTimer;
  #quotaAutoTimer;
  #countdownTicker;
  #statsNextAt;
  #quotaNextAt;
  #disposed = false;
  #deps;

  constructor({ redact = false, notify = false, version = "", channel = "", ui, deps = {} } = {}) {
    this.#redact = redact;
    this.#alerts.setEnabled(notify);
    this.#version = version;
    this.#channel = channel;
    this.#done = Promise.withResolvers();
    this.#deps = {
      fetchStats: deps.fetchStats ?? fetchStats,
      loadRequestWindow: deps.loadRequestWindow ?? loadRequestWindow,
      notify: deps.notify ?? (() => { if (process.stdout.isTTY) process.stdout.write("\x07"); }),
      loadHistoricalQuota: deps.loadHistoricalQuota ?? loadHistoricalQuota,
      createQuotaRefresh: deps.createQuotaRefresh ?? (() => new ProgressiveQuotaRefresh()),
      loadCacheDiagnostics: deps.loadCacheDiagnostics ?? loadCacheDiagnostics,
      now: deps.now ?? (() => Date.now()),
      setTimeout: deps.setTimeout ?? setTimeout,
      clearTimeout: deps.clearTimeout ?? clearTimeout,
      setInterval: deps.setInterval ?? setInterval,
      clearInterval: deps.clearInterval ?? clearInterval,
    };
    this.#ui = ui ?? new TerminalUI({ render: (w, h) => this.render(w, h), input: data => this.handleInput(data) });
  }

  async run() {
    this.#ui.start();
    this.#pushEvent("info", t("top.monitorStarted"));
    if (!this.#countdownTicker) {
      this.#countdownTicker = this.#deps.setInterval(() => {
        if (!this.#disposed) this.#ui.draw();
      }, COUNTDOWN_REDRAW_MS);
    }
    void this.#bootstrap();
    return this.#done.promise;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#quotaRun?.cancel();
    this.#clearStatsSchedule();
    this.#clearQuotaSchedule();
    if (this.#countdownTicker) this.#deps.clearInterval(this.#countdownTicker);
    this.#countdownTicker = undefined;
    this.#ui.stop();
  }

  #pushEvent(level, message) {
    this.#events.push({ at: this.#deps.now(), level, message: String(message) });
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
  }

  #clearStatsSchedule() {
    if (this.#statsAutoTimer) this.#deps.clearTimeout(this.#statsAutoTimer);
    this.#statsAutoTimer = undefined;
    this.#statsNextAt = undefined;
  }

  #clearQuotaSchedule() {
    if (this.#quotaAutoTimer) this.#deps.clearTimeout(this.#quotaAutoTimer);
    this.#quotaAutoTimer = undefined;
    this.#quotaNextAt = undefined;
  }

  #armStatsSchedule() {
    if (this.#disposed) return;
    this.#clearStatsSchedule();
    this.#statsNextAt = nextRefreshAt(this.#deps.now(), STATS_AUTO_REFRESH_MS);
    this.#statsAutoTimer = this.#deps.setTimeout(() => {
      this.#statsAutoTimer = undefined;
      this.#statsNextAt = undefined;
      this.#refreshStats();
    }, STATS_AUTO_REFRESH_MS);
    this.#ui.draw();
  }

  #armQuotaSchedule() {
    if (this.#disposed) return;
    this.#clearQuotaSchedule();
    this.#quotaNextAt = nextRefreshAt(this.#deps.now(), QUOTA_AUTO_REFRESH_MS);
    this.#quotaAutoTimer = this.#deps.setTimeout(() => {
      this.#quotaAutoTimer = undefined;
      this.#quotaNextAt = undefined;
      this.startQuotaRefresh();
    }, QUOTA_AUTO_REFRESH_MS);
    this.#ui.draw();
  }

  async #bootstrap() {
    try {
      const historical = await this.#deps.loadHistoricalQuota(this.#redact);
      if (historical.payload) {
        this.#snapshot.quota = historical.payload;
        const enabled = this.#alerts.enabled;
        this.#alerts.setEnabled(false);
        this.#alerts.evaluate(historical.payload, { now: this.#deps.now() });
        this.#alerts.setEnabled(enabled);
        const reportTimes = (historical.payload.reports ?? []).map(report => Number(report.fetchedAt)).filter(Number.isFinite);
        this.#snapshot.quotaUpdatedAt = reportTimes.length
          ? Math.max(...reportTimes)
          : historical.payload.generatedAt;
        for (const report of historical.payload.reports ?? []) {
          const old = this.#states.get(report.provider);
          this.#states.set(report.provider, { status: "stale", updatedAt: Math.max(old?.updatedAt ?? 0, report.fetchedAt ?? 0) });
        }
        this.#pushEvent("info", t("top.loadedHistory"));
        this.#ui.draw();
      }
    } catch (error) {
      this.#pushEvent("warn", t("top.historyUnavailable", { message: String(error?.message || error) }));
    }
    void this.refresh();
  }

  setStatus(text) { this.#status = text; this.#statusAt = this.#deps.now(); this.#ui.draw(); }

  async refresh() {
    this.#clearStatsSchedule();
    this.#clearQuotaSchedule();
    this.#refreshStats();
    if (!this.#quotaRefreshing) this.startQuotaRefresh();
  }

  #refreshStats() {
    if (this.#statsRefreshing || this.#disposed) return;
    this.#clearStatsSchedule();
    this.#statsRefreshing = true;
    this.#statsRefreshStartedAt = this.#deps.now();
    this.#statsError = undefined;
    this.#pushEvent("info", t("top.statsRefreshStarted"));
    this.#ui.draw();

    void (async () => {
      try {
        const raw = await this.#deps.fetchStats();
        if (this.#disposed) return;
        this.#snapshot.stats = normalizeStats(raw);
        this.#snapshot.statsUpdatedAt = this.#deps.now();
        this.#statsError = undefined;
        try {
          this.#snapshot.cacheDiagnostics = await this.#deps.loadCacheDiagnostics();
        } catch {
          this.#snapshot.cacheDiagnostics = undefined;
        }
        this.#pushEvent("ok", t("top.statsRefreshedEvent", { count: this.#snapshot.stats.byModel.length }));
        this.setStatus(this.#quotaRefreshing ? t("top.statsRefreshedQuotaPending") : t("top.statsRefreshed"));
      } catch (error) {
        if (!this.#disposed) {
          this.#statsError = String(error?.message || error);
          this.#pushEvent("error", `stats refresh failed: ${this.#statsError}`);
          this.setStatus(style.yellow(t("top.statsRefreshFailed", { message: this.#statsError })));
        }
      } finally {
        this.#statsRefreshing = false;
        this.#statsRefreshStartedAt = undefined;
        if (!this.#disposed) { this.#armStatsSchedule(); void this.#loadWindow(); }
        this.#ui.draw();
      }
    })();
  }

  async #loadWindow() {
    const run = ++this.#windowRun;
    this.#windowLoading = true;
    this.#ui.draw();
    try {
      const result = await this.#deps.loadRequestWindow({ hours: this.#windowHours, now: this.#deps.now() });
      if (!this.#disposed && run === this.#windowRun) this.#requestWindow = result;
    } catch (error) {
      if (!this.#disposed && run === this.#windowRun) this.#requestWindow = { available: false, reason: String(error.message) };
    } finally {
      if (!this.#disposed && run === this.#windowRun) { this.#windowLoading = false; this.#ui.draw(); }
    }
  }

  #notifyQuota() {
    const alerts = this.#alerts.evaluate(this.#snapshot.quota, { now: this.#deps.now(), providerStates: this.#states });
    for (const alert of alerts) this.#pushEvent("warn", t("notify.alert", { provider: providerLabel(alert.provider), label: alert.label, status: t("notify." + alert.status) }));
    if (alerts.length) this.#deps.notify();
  }

  startQuotaRefresh() {
    if (this.#quotaRefreshing || this.#disposed) return;
    this.#clearQuotaSchedule();
    this.#quotaRefreshing = true;
    for (const [provider, state] of this.#states) this.#states.set(provider, { ...state, status: "refreshing", error: undefined });
    const runner = this.#deps.createQuotaRefresh();
    this.#quotaRun = runner;
    this.#pushEvent("info", t("top.quotaRefreshStarted"));
    this.setStatus(t("top.quotaRefreshing"));

    void runner.run(this.#redact, {
      onProvider: (provider, reports, updatedAt) => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quota = mergeProviderReports(this.#snapshot.quota, provider, reports);
        this.#snapshot.quotaUpdatedAt = Math.max(this.#snapshot.quotaUpdatedAt ?? 0, updatedAt);
        this.#states.set(provider, { status: "fresh", updatedAt });
        this.#notifyQuota();
        this.#pushEvent("ok", t("top.providerUpdatedEvent", { provider: providerLabel(provider) }));
        this.setStatus(t("top.providerUpdated", { provider: providerLabel(provider) }));
      },
      onComplete: payload => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        this.#snapshot.quota = payload;
        const reportTimes = (payload.reports ?? []).map(report => Number(report.fetchedAt)).filter(Number.isFinite);
        this.#snapshot.quotaUpdatedAt = reportTimes.length
          ? Math.max(...reportTimes)
          : payload.generatedAt ?? this.#deps.now();
        const live = new Set((payload.reports ?? []).map(report => report.provider));
        for (const provider of live) {
          const reports = (payload.reports ?? []).filter(report => report.provider === provider);
          const updatedAt = Math.max(...reports.map(report => report.fetchedAt ?? payload.generatedAt ?? this.#deps.now()));
          this.#states.set(provider, { status: "fresh", updatedAt });
        }
        for (const [provider, state] of this.#states) {
          if (!live.has(provider) && state.status === "refreshing") this.#states.set(provider, { ...state, status: "stale" });
        }
        this.#notifyQuota();
        this.#pushEvent("ok", t("top.quotaCompleteEvent", { count: live.size }));
        this.setStatus(t("top.quotaComplete"));
      },
      onError: message => {
        if (this.#disposed || this.#quotaRun !== runner) return;
        for (const [provider, state] of this.#states) {
          if (state.status === "refreshing") this.#states.set(provider, { ...state, status: "error", error: message });
        }
        this.#pushEvent("error", t("top.quotaErrorEvent", { message }));
        this.setStatus(style.yellow(t("top.quotaError", { message })));
      },
    }).finally(() => {
      if (this.#quotaRun !== runner) return;
      this.#quotaRun = undefined;
      this.#quotaRefreshing = false;
      for (const [provider, state] of this.#states) {
        if (state.status === "refreshing") this.#states.set(provider, { ...state, status: "stale" });
      }
      if (!this.#disposed) this.#armQuotaSchedule();
      this.#ui.draw();
    });
  }

  #switchView(index) {
    if (index === this.#viewIndex) return;
    this.#scrollByView.set(this.#viewIndex, this.#scroll);
    this.#viewIndex = index;
    this.#scroll = this.#scrollByView.get(index) ?? 0;
    this.#ui.draw();
  }

  #inspectionState() {
    if (!this.#inspectionByView.has(this.#viewIndex)) this.#inspectionByView.set(this.#viewIndex, { detailOffset: 0 });
    return this.#inspectionByView.get(this.#viewIndex);
  }

  #follow(target) {
    if (!target) return;
    const previous = { viewIndex: this.#viewIndex, state: { ...this.#inspectionState() } };
    this.#switchView(VIEWS.findIndex(view => view.id === target.view));
    this.#history.push(previous);
    this.#inspectionByView.set(this.#viewIndex, { ...target, detailOffset: 0 });
    this.#inspecting = true;
    this.#ui.draw();
  }

  handleInput(data) {
    if (this.#searchDraft !== undefined) {
      if (data === Keys.escape) this.#searchDraft = undefined;
      else if (data === "\r" || data === "\n") {
        Object.assign(this.#inspectionState(), { query: this.#searchDraft, selected: undefined, detailOffset: 0 });
        this.#searchDraft = undefined;
      } else if (data === "\x7f" || data === "\b") this.#searchDraft = [...this.#searchDraft].slice(0,-1).join("");
      else if (data === "\x15") this.#searchDraft = "";
      else if (!/[\x00-\x1f\x7f]/u.test(data)) this.#searchDraft = (this.#searchDraft + data).slice(0,512);
      else if (data === Keys.ctrlC || data === Keys.ctrlD) this.#done.resolve();
      this.#ui.draw(); return;
    }
    if (data === "w") {
      this.#windowHours = [1, 6, 24][([1, 6, 24].indexOf(this.#windowHours) + 1) % 3];
      this.#requestWindow = undefined;
      this.#scroll = 0;
      void this.#loadWindow(); return;
    }
    if (data === "v") { this.#comparisonOpen = !this.#comparisonOpen; this.#scroll = 0; this.#ui.draw(); return; }
    if (data === Keys.escape && this.#comparisonOpen) { this.#comparisonOpen = false; this.#scroll = 0; this.#ui.draw(); return; }
    if (data === "n") {
      if (!this.#alerts.enabled) this.#notifyQuota();
      this.#alerts.setEnabled(!this.#alerts.enabled);
      this.setStatus(t(this.#alerts.enabled ? "notify.on" : "notify.off")); return;
    }
    if (data === "?" && !this.#inspecting) { this.#inspecting = true; this.#inspectionState().help = true; this.#ui.draw(); return; }
    if (data === "/") { this.#inspecting = true; this.#searchDraft = this.#inspectionState().query ?? ""; this.#ui.draw(); return; }
    if (this.#inspecting && (data === "b" || data === Keys.escape)) {
      const previous = this.#history.pop();
      if (previous) {
        this.#switchView(previous.viewIndex);
        this.#inspectionByView.set(previous.viewIndex, previous.state);
      } else if (data === Keys.escape) this.#inspecting = false;
      this.#ui.draw(); return;
    }
    if (data === "\r" || data === "\n") {
      if (this.#inspecting) this.#follow(this.#entries.find(row => row.id === this.#inspectionState().selected)?.target);
      else { this.#inspecting = true; this.#ui.draw(); }
      return;
    }
    if (this.#inspecting && !this.#comparisonOpen) {
      const state = this.#inspectionState();
      const index = Math.max(0, this.#entries.findIndex(row => row.id === state.selected));
      if (["s", "f", "c", "?"].includes(data)) {
        if (data === "s") state.sort = SORT_ORDERS[(SORT_ORDERS.indexOf(state.sort ?? "source") + 1) % SORT_ORDERS.length];
        if (data === "f") state.provider = [undefined, ...this.#providers][([undefined, ...this.#providers].indexOf(state.provider) + 1) % (this.#providers.length + 1)];
        if (data === "c") { state.query = ""; state.provider = undefined; }
        if (data === "?") { state.help = !state.help; state.detailOffset = 0; }
        this.#ui.draw(); return;
      }
      let next = index;
      if (data === "j" || data === Keys.down) next++;
      else if (data === "k" || data === Keys.up) next--;
      else if (Keys.home.has(data)) next = 0;
      else if (Keys.end.has(data)) next = this.#entries.length - 1;
      else if (data === Keys.pageDown) state.detailOffset += Math.max(1, this.#bodyHeight - 6);
      else if (data === Keys.pageUp) state.detailOffset = Math.max(0, state.detailOffset - Math.max(1, this.#bodyHeight - 6));
      else next = undefined;
      if (next !== undefined) {
        if (next !== index) state.detailOffset = 0;
        state.selected = this.#entries[Math.max(0, Math.min(next, this.#entries.length - 1))]?.id;
        this.#ui.draw(); return;
      }
    }
    if ([Keys.ctrlC, Keys.ctrlD, Keys.escape].includes(data) || data === "q") { this.#done.resolve(); return; }
    if (data === "r") { void this.refresh(); return; }
    const direct = directViewIndex(data);
    if (direct !== undefined) { this.#switchView(direct); return; }
    if (data === Keys.tab || data === Keys.right) { this.#switchView(nextViewIndex(this.#viewIndex, 1)); return; }
    if (data === Keys.shiftTab || data === Keys.left) { this.#switchView(nextViewIndex(this.#viewIndex, -1)); return; }
    if (data === "j" || data === Keys.down) this.#scroll += 1;
    else if (data === "k" || data === Keys.up) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (data === Keys.pageDown) this.#scroll += this.#bodyHeight;
    else if (data === Keys.pageUp) this.#scroll = Math.max(0, this.#scroll - this.#bodyHeight);
    else if (Keys.home.has(data)) this.#scroll = 0;
    else if (Keys.end.has(data)) this.#scroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#ui.draw();
  }

  #freshnessLane(nextAt, refreshing) {
    if (refreshing) return t("top.refreshingShort");
    if (!nextAt) return t("top.pending");
    return t("top.nextCountdown", { next: formatCountdown(nextAt, this.#deps.now()) });
  }

  render(width, height) {
    const workspace = workspaceGeometry(width);
    const identity = [style.bold("OMP TOP")];
    if (this.#version) identity.push(`v${this.#version}`);
    if (this.#channel) identity.push(this.#channel);
    if (process.env.OMP_PROFILE) identity.push(t("top.profile", { name: process.env.OMP_PROFILE }));
    const title = identity.join(style.dim(" · "));

    const freshness = style.dim(t("top.statsFreshness", {
          stats: this.#freshnessLane(this.#statsNextAt, this.#statsRefreshing),
          quota: this.#freshnessLane(this.#quotaNextAt, this.#quotaRefreshing),
        }));
    const tabs = renderViewTabs(this.#viewIndex, workspace.innerWidth);
    const navLine = tabs;

    const statsState = {
      refreshing: this.#statsRefreshing,
      startedAt: this.#statsRefreshStartedAt,
      updatedAt: this.#snapshot.statsUpdatedAt,
      error: this.#statsError,
    };
    const view = VIEWS[this.#viewIndex] ?? VIEWS[0];
    const local = this.#requestWindow?.available && this.#requestWindow.hours === this.#windowHours ? this.#requestWindow : undefined;
    const context = {
      stats: local ? { ...local.stats, windowHours: this.#windowHours } : this.#windowHours === 24 ? this.#snapshot.stats : undefined,
      ompStats: local ? this.#snapshot.stats : undefined,
      statsState: local ? { refreshing: this.#windowLoading, updatedAt: local.untilMs }
        : this.#windowHours !== 24 ? { refreshing: this.#windowLoading, error: this.#requestWindow?.reason } : statsState,
      quota: this.#snapshot.quota,
      cacheDiagnostics: local?.diagnostics ?? (this.#windowHours === 24 ? this.#snapshot.cacheDiagnostics : undefined),
      providerStates: this.#states,
      quotaRefreshing: this.#quotaRefreshing,
      quotaNextAt: this.#quotaNextAt,
      now: this.#deps.now(),
      events: this.#events,
    };

    const compactChrome = height < 16;
    const bodyHeight = Math.max(0, height - (compactChrome ? 5 : 8));
    this.#bodyHeight = Math.max(1, bodyHeight);
    const state = this.#inspectionState();
    const explored = exploreEntries(view.id, context, state);
    this.#entries = explored.entries;
    this.#providers = explored.providers;
    state.emptyMessage = explored.reason;
    const windowState = { hours: this.#windowHours, result: this.#requestWindow, loading: this.#windowLoading };
    const body = this.#comparisonOpen ? renderComparison(windowState, workspace.innerWidth) : this.#inspecting
      ? renderInspection(this.#entries, state, workspace.innerWidth, bodyHeight)
      : renderWorkspace(view.id, context, workspace.innerWidth, height);
    if (!this.#comparisonOpen && !this.#inspecting) body.unshift(...wrapLines([windowSummary(windowState)], workspace.innerWidth), "");
    const maxOffset = Math.max(0, body.length - bodyHeight);
    const savedScroll = this.#scroll;
    if (this.#scroll === Number.MAX_SAFE_INTEGER) this.#scroll = maxOffset;
    this.#scroll = Math.max(0, Math.min(this.#scroll, maxOffset));
    const visible = body.slice(this.#scroll, this.#scroll + bodyHeight);
    if (this.#inspecting && !this.#comparisonOpen) this.#scroll = savedScroll;
    while (visible.length < bodyHeight) visible.push("");

    const activeStatus = this.#deps.now() - this.#statusAt < STATUS_TTL_MS && this.#status
      ? this.#status
      : style.dim(t("state.ready", { view: viewLabel(view) }));
    const scrollState = maxOffset > 0
      ? style.dim(t("top.scroll", { current: this.#scroll + 1, total: maxOffset + 1 }))
      : "";
    const inspectionStatus = `${t("explore.search")}: ${state.query || "—"} · ${t("explore.sort")}: ${t("explore." + (state.sort ?? "source"))} · ${t("explore.provider")}: ${state.provider || state.scope?.provider || t("explore.all")}${state.level ? " · " + t("explore." + state.level) : ""}`;
    const statusLine = this.#searchDraft !== undefined ? `${t("explore.search")}: /${this.#searchDraft}▌`
      : this.#inspecting && !this.#comparisonOpen ? inspectionStatus : composeSides(activeStatus, scrollState, workspace.innerWidth);
    const hints = this.#searchDraft !== undefined ? t("explore.searchHint") : this.#inspecting && !this.#comparisonOpen ? t("explore.hints") : t("explore.dashboardHints");

    const framed = [
      frameTop(workspace.width, title),
      frameRow(navLine, workspace.width),
      ...(!compactChrome ? [frameRow(composeSides(freshness, `w:${this.#windowHours}h · n:${this.#alerts.enabled ? "on" : "off"}`, workspace.innerWidth), workspace.width), frameDivider(workspace.width)] : []),
      ...visible.map(line => frameRow(line, workspace.width)),
      ...(!compactChrome ? [frameDivider(workspace.width)] : []),
      frameRow(statusLine, workspace.width),
      frameRow(style.dim(hints), workspace.width),
      frameBottom(workspace.width),
    ];
    return framed.map(line => offsetLine(line, workspace.offset));
  }
}
