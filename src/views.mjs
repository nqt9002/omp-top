import { aggregateCacheByProvider, cacheRate, sortModels } from "./stats.mjs";
import { modelPerformanceRows } from "./intelligence.mjs";
import { quotaDisplayGroups } from "./quota.mjs";
import { joinColumns, renderMetricGrid, sectionTitle } from "./layout.mjs";
import { t } from "./i18n.mjs";
import {
  style, compactNumber, percent, providerLabel, usedFraction, quotaColor, cacheColor,
  progressBar, formatReset, formatClock, formatAge, formatDuration, formatMoney,
  formatHours, formatPercentPerHour, formatUntil, sparkline, truncateAnsi, padRight,
} from "./format.mjs";

export const VIEWS = [
  { id: "overview", key: "1", labelKey: "view.overview", shortKey: "view.overt(view.shortKey)" },
  { id: "quota", key: "2", labelKey: "view.quota", shortKey: "view.quota.short" },
  { id: "models", key: "3", labelKey: "view.models", shortKey: "view.models.short" },
  { id: "cache", key: "4", labelKey: "view.cache", shortKey: "view.cache.short" },
  { id: "agents", key: "5", labelKey: "view.agents", shortKey: "view.agents.short" },
  { id: "events", key: "6", labelKey: "view.events", shortKey: "view.events.short" },
];

export function viewLabel(viewOrId) {
  const view = typeof viewOrId === "string" ? VIEWS.find(item => item.id === viewOrId) : viewOrId;
  return view ? t(t(view.labelKey)Key) : String(viewOrId ?? "");
}

export function nextViewIndex(index, delta) {
  return (index + delta + VIEWS.length) % VIEWS.length;
}

export function directViewIndex(key) {
  const index = VIEWS.findIndex(view => view.key === key);
  return index >= 0 ? index : undefined;
}

export function renderViewTabs(activeIndex, width) {
  const compact = width < 72;
  const pieces = VIEWS.map((view, index) => {
    if (compact) {
      return index === activeIndex
        ? `${style.cyan("▌")}${style.inverse(` ${t(view.shortKey)} `)}`
        : `${style.dim(view.key)}:${t(view.shortKey)}`;
    }
    return index === activeIndex
      ? `${style.cyan("▌")}${style.inverse(` ${t(view.labelKey)} `)}${style.dim(` ${view.key}`)}`
      : `${style.dim(view.key)} ${t(view.labelKey)}`;
  });
  return truncateAnsi(pieces.join(compact ? "  " : "   "), width);
}

export function statsStateText({ stats, refreshing, startedAt, updatedAt, error, now = Date.now() }) {
  const elapsed = startedAt ? formatAge(startedAt, now) : "0s";
  if (refreshing && !stats) return style.yellow(`↻ calculating · ${elapsed}`);
  if (refreshing && stats) return style.yellow(`↻ refreshing · ${elapsed} · previous`);
  if (error && stats) return style.red("⚠ refresh failed · previous");
  if (error) return style.red("⚠ unavailable");
  if (stats && updatedAt) return style.green(`✓ ${formatClock(updatedAt)}`);
  return style.dim("not loaded");
}

function providerStateText(state, refreshing) {
  if (!state) return refreshing ? style.yellow("↻ refreshing") : "";
  const stamp = state.updatedAt ? ` · ${formatAge(state.updatedAt)} ago` : "";
  if (state.status === "fresh") return style.green(`✓ fresh${stamp}`);
  if (state.status === "refreshing") return style.yellow(`↻ refreshing${stamp ? ` · last ${formatClock(state.updatedAt)}` : ""}`);
  if (state.status === "error") return style.red(`⚠ stale${stamp}`);
  return style.dim(`stale${stamp}`);
}

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

function quotaRiskSummary(quota) {
  let windows = 0;
  let atRisk = 0;
  let watch = 0;
  let exhausted = 0;
  let nextProjected;
  for (const report of quota?.reports ?? []) {
    for (const group of quotaDisplayGroups(report)) {
      for (const limit of group.limits) {
        windows++;
        const fraction = usedFraction(limit.amount ?? {});
        const status = limit.intelligence?.status;
        if (status === "exhausted" || Number(fraction) >= 1) exhausted++;
        else if (status === "at-risk") atRisk++;
        else if (status === "watch" || Number(fraction) >= 0.8) watch++;
        if (status === "at-risk") {
          const projected = Number(limit.intelligence?.projectedExhaustAt);
          if (Number.isFinite(projected) && projected > Date.now() && (nextProjected === undefined || projected < nextProjected)) {
            nextProjected = projected;
          }
        }
      }
    }
  }
  return { windows, atRisk, watch, exhausted, nextProjected };
}

function errorMetric(fraction) {
  const text = percent(fraction);
  if (!Number.isFinite(fraction) || fraction <= 0) return text;
  if (fraction >= 0.05) return style.red(text);
  if (fraction >= 0.01) return style.yellow(text);
  return text;
}

function renderSystemHealth(stats, statsState, width) {
  const state = statsStateText({ stats, ...statsState });
  const lines = [sectionTitle("System health", width, state)];
  if (!stats) {
    if (statsState?.refreshing) {
      lines.push(style.dim(" First load may take a while · syncing OMP session history and calculating stats…"));
    } else {
      lines.push(style.dim(" Stats have not been loaded yet."));
    }
    return lines;
  }

  const o = stats.overall ?? {};
  const cacheRateValue = Number(o.cacheRate || 0);
  const metrics = [
    { label: style.dim("Requests"), value: style.bold(compactNumber(Number(o.totalRequests || 0))) },
    { label: style.dim("Cache hit"), value: cacheColor(cacheRateValue, percent(cacheRateValue)) },
    { label: style.dim("Errors"), value: errorMetric(Number(o.errorRate || 0)) },
    { label: style.dim("Avg TTFT"), value: formatDuration(Number(o.avgTtft)) },
    { label: style.dim("Avg TPS"), value: Number.isFinite(Number(o.avgTokensPerSecond)) ? Number(o.avgTokensPerSecond).toFixed(1) : "-" },
    { label: style.dim("Latency"), value: formatDuration(Number(o.avgDuration)) },
    { label: style.dim("Input"), value: compactNumber(Number(o.totalInputTokens || 0)) },
    { label: style.dim("Output"), value: compactNumber(Number(o.totalOutputTokens || 0)) },
    { label: style.dim("API est.*"), value: formatMoney(Number(o.totalCost)) },
  ];
  lines.push(...renderMetricGrid(metrics, width));
  lines.push(style.dim(" * API-equivalent cost estimate reported by the current OMP stats snapshot."));
  return lines;
}

function renderQuotaHealth(quota, width) {
  const risk = quotaRiskSummary(quota);
  const lines = [sectionTitle("Quota health", width)];
  if (!risk.windows) {
    lines.push(style.dim(" Waiting for quota data…"));
    return lines;
  }

  lines.push(...renderMetricGrid([
    { label: style.dim("Windows"), value: String(risk.windows) },
    { label: style.dim("Exhausted"), value: risk.exhausted ? style.red(String(risk.exhausted)) : "0" },
    { label: style.dim("At risk"), value: risk.atRisk ? style.red(String(risk.atRisk)) : "0" },
    { label: style.dim("Watch"), value: risk.watch ? style.yellow(String(risk.watch)) : "0" },
  ], width));

  lines.push("");
  if (risk.exhausted) {
    lines.push(` ${style.red("●")} Immediate   ${style.red(`${risk.exhausted} exhausted NOW`)}`);
  } else {
    lines.push(` ${style.green("●")} Immediate   no exhausted quota windows`);
  }
  if (risk.nextProjected) {
    lines.push(` ${style.yellow("●")} Next risk    projected exhaustion in ${formatUntil(risk.nextProjected)}`);
  } else if (risk.atRisk) {
    lines.push(` ${style.yellow("●")} Next risk    at-risk window has insufficient ETA history`);
  } else {
    lines.push(` ${style.dim("●")} Next risk    no projected exhaustion before reset`);
  }
  return lines;
}

function renderTraffic(stats, width) {
  const lines = [sectionTitle("Traffic", width)];
  const series = stats?.timeSeries ?? [];
  if (!series.length) {
    lines.push(style.dim(" No time-series data in this OMP stats snapshot."));
    return lines;
  }
  const points = Math.max(8, Math.min(48, width - 12));
  const requests = series.map(point => point?.totalRequests ?? point?.requests ?? point?.count ?? 0);
  const errors = series.map(point => point?.failedRequests ?? point?.errors ?? 0);
  lines.push(
    ` Requests  ${sparkline(requests, points)}`,
    ` Errors    ${sparkline(errors, points)}`,
  );
  return lines;
}

function tableCell(value, width) {
  return padRight(truncateAnsi(String(value ?? ""), Math.max(1, width)), Math.max(1, width));
}

function renderTopModels(stats, width) {
  const rows = modelPerformanceRows(stats).slice(0, 5);
  const lines = [sectionTitle("Top models", width)];
  if (!rows.length) {
    lines.push(style.dim(" No model statistics reported."));
    return lines;
  }

  if (width < 92) {
    for (const row of rows) {
      const label = `${providerLabel(row.provider)}/${row.model}`;
      lines.push(` ${truncateAnsi(label, Math.max(18, width - 2))}`);
      lines.push(style.dim(`   ${compactNumber(row.totalRequests)} req · ${percent(row.errorRate)} err · ${Number.isFinite(row.avgTokensPerSecond) ? row.avgTokensPerSecond.toFixed(1) : "-"} TPS · ${formatDuration(row.avgTtft)} TTFT`));
    }
    return lines;
  }

  const providerWidth = width >= 132 ? 20 : 16;
  const modelWidth = Math.max(18, width - providerWidth - 47);
  lines.push(style.dim(`  ${tableCell("Provider", providerWidth)} ${tableCell("Model", modelWidth)} ${"Req".padStart(7)} ${"Err".padStart(7)} ${"TPS".padStart(7)} ${"TTFT".padStart(8)} ${"API est.*".padStart(10)}`));
  for (const row of rows) {
    const req = compactNumber(row.totalRequests).padStart(7);
    const err = percent(row.errorRate).padStart(7);
    const tps = (Number.isFinite(row.avgTokensPerSecond) ? row.avgTokensPerSecond.toFixed(1) : "-").padStart(7);
    const ttft = formatDuration(row.avgTtft).padStart(8);
    const cost = formatMoney(row.totalCost).padStart(10);
    lines.push(`  ${tableCell(providerLabel(row.provider), providerWidth)} ${tableCell(row.model, modelWidth)} ${req} ${err} ${tps} ${ttft} ${cost}`);
  }
  return lines;
}

function renderOverview(context, width) {
  const health = renderSystemHealth(context.stats, context.statsState, width);
  const quota = renderQuotaHealth(context.quota, width >= 108 ? Math.floor((width - 4) / 2) : width);
  const traffic = renderTraffic(context.stats, width >= 108 ? width - 4 - Math.floor((width - 4) / 2) : width);
  return [
    ...health,
    "",
    ...joinColumns(quota, traffic, width, { gap: 4, minWidth: 108 }),
    "",
    ...renderTopModels(context.stats, width),
  ];
}

function intelligenceLine(limit) {
  const intel = limit?.intelligence;
  if (!intel || (intel.sampleCount ?? 0) < 2 || intel.burnPerHour === undefined) return style.dim("history: collecting samples · burn - · ETA -");
  const burn = formatPercentPerHour(intel.burnPerHour);
  const eta = intel.status === "exhausted" ? "NOW" : formatHours(intel.etaHours);
  const sustainable = formatPercentPerHour(intel.sustainablePerHour);
  const pace = Number.isFinite(intel.paceRatio) ? `${intel.paceRatio.toFixed(2)}×` : "-";
  const text = `burn ${burn} · ETA ${eta} · sustainable ${sustainable} · pace ${pace}`;
  if (intel.status === "exhausted" || intel.status === "at-risk") return style.red(text);
  if (intel.status === "watch") return style.yellow(text);
  return style.dim(text);
}

function renderQuota(context, width) {
  const { quota, providerStates = new Map(), quotaRefreshing } = context;
  const reports = quota?.reports ?? [];
  const lines = [sectionTitle("Quota / runway", width)];
  if (!reports.length) {
    lines.push(quotaRefreshing ? style.dim(" Waiting for quota results…") : style.dim(" No quota data available"));
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
    const state = providerStateText(providerStates.get(provider), quotaRefreshing);
    lines.push(` ${style.bold(providerLabel(provider))}${state ? `  ${state}` : ""}`);
    providerReports.sort((a, b) => accountLabel(a, "").localeCompare(accountLabel(b, ""))).forEach((report, index) => {
      const identity = accountLabel(report, providerReports.length > 1 ? `Account ${index + 1}` : "Account");
      const plan = planLabel(report);
      lines.push(`   ${style.cyan(identity)}${plan ? style.dim(` · ${plan}`) : ""}`);
      const groups = quotaDisplayGroups(report);
      const hasLimits = groups.some(group => group.limits.length > 0);
      if (!hasLimits) { lines.push(style.dim("     no quota windows reported")); return; }
      const groupedAntigravity = report.provider === "google-antigravity" && groups.some(group => group.label);
      for (const group of groups) {
        if (groupedAntigravity && group.label) lines.push(`     ${style.bold(group.label)}`);
        for (const limit of group.limits) {
          const fraction = usedFraction(limit.amount ?? {});
          const windowLabel = String(limit.window?.label || limit.scope?.windowId || limit.id || "limit");
          const labelWidth = groupedAntigravity ? 20 : 22;
          const label = tableCell(windowLabel, labelWidth);
          const barWidth = Math.max(6, Math.min(24, width - (groupedAntigravity ? 54 : 52)));
          const bar = progressBar(fraction, barWidth);
          const pct = percent(fraction).padStart(6);
          const reset = formatReset(limit.window?.resetsAt).padStart(13);
          const indent = groupedAntigravity ? "       " : "     ";
          lines.push(`${indent}${label} ${bar} ${quotaColor(fraction, pct)} ${reset}`.trimEnd());
          lines.push(`${indent}${" ".repeat(Math.min(labelWidth + 1, 23))}${intelligenceLine(limit)}`.trimEnd());
        }
      }
    });
  }
  return lines;
}

function renderModels(context, width) {
  const rows = modelPerformanceRows(context.stats);
  const lines = [sectionTitle("Model performance", width)];
  lines.push(style.dim(" API est.* is the API-equivalent cost estimate in the current OMP stats snapshot."));
  if (!rows.length) { lines.push(style.dim(" No per-model statistics reported.")); return lines; }
  if (width < 96) {
    for (const row of rows) {
      lines.push("", ` ${style.bold(providerLabel(row.provider))} · ${row.model}`);
      lines.push(`   req ${compactNumber(row.totalRequests)} · err ${percent(row.errorRate)} · TTFT ${formatDuration(row.avgTtft)} · TPS ${Number.isFinite(row.avgTokensPerSecond) ? row.avgTokensPerSecond.toFixed(1) : "-"}`);
      lines.push(style.dim(`   latency ${formatDuration(row.avgDuration)} · API est.* ${formatMoney(row.totalCost)}`));
    }
    return lines;
  }

  const providerWidth = width >= 132 ? 20 : 16;
  const modelWidth = Math.max(18, width - providerWidth - 56);
  lines.push(style.dim(`  ${tableCell("Provider", providerWidth)} ${tableCell("Model", modelWidth)} ${"Req".padStart(7)} ${"Err".padStart(7)} ${"TTFT".padStart(8)} ${"TPS".padStart(7)} ${"Latency".padStart(8)} ${"API est.*".padStart(10)}`));
  for (const row of rows) {
    const req = compactNumber(row.totalRequests).padStart(7);
    const err = percent(row.errorRate).padStart(7);
    const ttft = formatDuration(row.avgTtft).padStart(8);
    const tps = (Number.isFinite(row.avgTokensPerSecond) ? row.avgTokensPerSecond.toFixed(1) : "-").padStart(7);
    const latency = formatDuration(row.avgDuration).padStart(8);
    const cost = formatMoney(row.totalCost).padStart(10);
    lines.push(`  ${tableCell(providerLabel(row.provider), providerWidth)} ${tableCell(row.model, modelWidth)} ${req} ${err} ${ttft} ${tps} ${latency} ${cost}`);
  }
  return lines;
}

function renderCache(context, width) {
  const stats = context.stats;
  const lines = [sectionTitle("Cache efficiency", width)];
  if (!stats) { lines.push(style.dim(" Stats have not been loaded yet.")); return lines; }
  const o = stats.overall ?? {};
  lines.push(...renderMetricGrid([
    { label: style.dim("Overall hit"), value: cacheColor(Number(o.cacheRate || 0), percent(Number(o.cacheRate || 0))) },
    { label: style.dim("Cache read"), value: compactNumber(Number(o.totalCacheReadTokens || 0)) },
    { label: style.dim("Cache write"), value: compactNumber(Number(o.totalCacheWriteTokens || 0)) },
    { label: style.dim("Savings"), value: percent(Number(o.cacheSavings || 0)) },
  ], width));

  const providers = aggregateCacheByProvider(stats.byModel);
  if (providers.length) {
    lines.push("", sectionTitle("By provider", width));
    if (width < 68) {
      for (const row of providers) {
        lines.push(` ${style.bold(providerLabel(row.provider))}`);
        lines.push(`   req ${compactNumber(row.totalRequests)} · hit ${percent(row.cacheRate)} · read ${compactNumber(row.totalCacheReadTokens)} · write ${compactNumber(row.totalCacheWriteTokens)}`);
      }
    } else {
      lines.push(style.dim("  Provider                   Req      Hit       Read      Write"));
      for (const row of providers) {
        const name = tableCell(providerLabel(row.provider), 24);
        const req = compactNumber(row.totalRequests).padStart(7);
        const hit = percent(row.cacheRate).padStart(7);
        const read = compactNumber(row.totalCacheReadTokens).padStart(9);
        const write = compactNumber(row.totalCacheWriteTokens).padStart(9);
        lines.push(`  ${name} ${req} ${cacheColor(row.cacheRate, hit)} ${read} ${write}`);
      }
    }
  }

  const models = sortModels(stats.byModel);
  if (models.length) {
    lines.push("", sectionTitle("By model", width));
    if (width < 96) {
      for (const row of models) {
        const rate = Number(row.cacheRate || 0);
        lines.push(` ${providerLabel(String(row.provider ?? "unknown"))}/${String(row.model ?? "unknown")}`);
        lines.push(`   req ${compactNumber(Number(row.totalRequests || 0))} · hit ${percent(rate)} · read ${compactNumber(Number(row.totalCacheReadTokens || 0))} · write ${compactNumber(Number(row.totalCacheWriteTokens || 0))}`);
      }
    } else {
      const providerWidth = width >= 132 ? 20 : 16;
      const modelWidth = Math.max(18, width - providerWidth - 47);
      lines.push(style.dim(`  ${tableCell("Provider", providerWidth)} ${tableCell("Model", modelWidth)} ${"Req".padStart(7)} ${"Hit".padStart(7)} ${"Read".padStart(8)} ${"Write".padStart(8)} ${"Save".padStart(7)}`));
      for (const row of models) {
        const rate = Number(row.cacheRate || 0);
        const req = compactNumber(Number(row.totalRequests || 0)).padStart(7);
        const hit = percent(rate).padStart(7);
        const read = compactNumber(Number(row.totalCacheReadTokens || 0)).padStart(8);
        const write = compactNumber(Number(row.totalCacheWriteTokens || 0)).padStart(8);
        const save = percent(Number(row.cacheSavings || 0)).padStart(7);
        lines.push(`  ${tableCell(providerLabel(String(row.provider ?? "unknown")), providerWidth)} ${tableCell(String(row.model ?? "unknown"), modelWidth)} ${req} ${cacheColor(rate, hit)} ${read} ${write} ${save}`);
      }
    }
  }
  return lines;
}

function renderAgents(context, width) {
  const rows = context.stats?.byAgentType ?? [];
  const lines = [sectionTitle("Agent / role attribution", width)];
  if (!rows.length) {
    lines.push(style.dim(" This OMP stats snapshot did not report byAgentType data."));
    return lines;
  }
  const sorted = [...rows].sort((a, b) => Number(b.totalRequests || 0) - Number(a.totalRequests || 0));
  const totalTokens = rows.reduce((sum, row) => sum + Number(row.totalInputTokens || 0) + Number(row.totalOutputTokens || 0), 0);
  if (width < 96) {
    for (const row of sorted) {
      const tokens = Number(row.totalInputTokens || 0) + Number(row.totalOutputTokens || 0);
      const share = percent(totalTokens > 0 ? tokens / totalTokens : 0);
      const cache = percent(cacheRate(Number(row.totalInputTokens || 0), Number(row.totalCacheReadTokens || 0)));
      lines.push("", ` ${style.bold(String(row.agentType ?? row.type ?? "unknown"))}`);
      lines.push(`   req ${compactNumber(Number(row.totalRequests || 0))} · share ${share} · cache ${cache}`);
      lines.push(style.dim(`   input ${compactNumber(Number(row.totalInputTokens || 0))} · output ${compactNumber(Number(row.totalOutputTokens || 0))} · API est.* ${formatMoney(Number(row.totalCost))}`));
    }
    return lines;
  }

  const nameWidth = Math.max(20, width - 57);
  lines.push(style.dim(`  ${tableCell("Agent / role", nameWidth)} ${"Req".padStart(7)} ${"Share".padStart(7)} ${"Input".padStart(9)} ${"Output".padStart(9)} ${"Cache".padStart(7)} ${"API est.*".padStart(10)}`));
  for (const row of sorted) {
    const name = tableCell(String(row.agentType ?? row.type ?? "unknown"), nameWidth);
    const req = compactNumber(Number(row.totalRequests || 0)).padStart(7);
    const tokens = Number(row.totalInputTokens || 0) + Number(row.totalOutputTokens || 0);
    const share = percent(totalTokens > 0 ? tokens / totalTokens : 0).padStart(7);
    const input = compactNumber(Number(row.totalInputTokens || 0)).padStart(9);
    const output = compactNumber(Number(row.totalOutputTokens || 0)).padStart(9);
    const cache = percent(cacheRate(Number(row.totalInputTokens || 0), Number(row.totalCacheReadTokens || 0))).padStart(7);
    const cost = formatMoney(Number(row.totalCost)).padStart(10);
    lines.push(`  ${name} ${req} ${share} ${input} ${output} ${cache} ${cost}`);
  }
  return lines;
}

function renderEvents(context, width) {
  const events = context.events ?? [];
  const lines = [sectionTitle("Runtime events", width)];
  lines.push(style.dim(" In-memory only · newest first · no persistent event log"));
  if (!events.length) { lines.push(style.dim(" No events yet.")); return lines; }
  for (const event of [...events].reverse()) {
    const level = String(event.level || "info").toUpperCase().padEnd(5);
    let label = style.dim(level);
    if (event.level === "error") label = style.red(level);
    else if (event.level === "warn") label = style.yellow(level);
    else if (event.level === "ok") label = style.green(level);
    lines.push(truncateAnsi(` ${formatClock(event.at)}  ${label}  ${event.message}`, width));
  }
  return lines;
}

export function renderView(viewId, context, width) {
  if (viewId === "quota") return renderQuota(context, width);
  if (viewId === "models") return renderModels(context, width);
  if (viewId === "cache") return renderCache(context, width);
  if (viewId === "agents") return renderAgents(context, width);
  if (viewId === "events") return renderEvents(context, width);
  return renderOverview(context, width);
}
