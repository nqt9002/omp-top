import { aggregateCacheByProvider, cacheRate, sortModels } from "./stats.mjs";
import { modelPerformanceRows } from "./intelligence.mjs";
import { quotaDisplayGroups } from "./quota.mjs";
import {
  style, compactNumber, percent, providerLabel, usedFraction, quotaColor, cacheColor,
  progressBar, formatReset, formatClock, formatAge, formatDuration, formatMoney,
  formatHours, formatPercentPerHour, sparkline, visibleWidth, truncateAnsi, padRight,
} from "./format.mjs";

export const VIEWS = [
  { id: "overview", key: "1", label: "Overview" },
  { id: "quota", key: "2", label: "Quota" },
  { id: "models", key: "3", label: "Models" },
  { id: "cache", key: "4", label: "Cache" },
  { id: "agents", key: "5", label: "Agents" },
  { id: "events", key: "6", label: "Events" },
];

export function nextViewIndex(index, delta) {
  return (index + delta + VIEWS.length) % VIEWS.length;
}

export function directViewIndex(key) {
  const index = VIEWS.findIndex(view => view.key === key);
  return index >= 0 ? index : undefined;
}

export function renderViewTabs(activeIndex, width) {
  const pieces = VIEWS.map((view, index) => index === activeIndex
    ? style.cyan(style.bold(`[${view.key} ${view.label}]`))
    : style.dim(` ${view.key} ${view.label} `));
  return truncateAnsi(` ${pieces.join(" ")}`, width);
}

function sectionTitle(label, width, status = "") {
  const statusWidth = visibleWidth(status);
  const available = Math.max(4, width - label.length - statusWidth - (status ? 4 : 2));
  const ruleWidth = Math.max(4, Math.min(28, available));
  return `${style.bold(label)} ${style.dim("─".repeat(ruleWidth))}${status ? `  ${status}` : ""}`;
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

function twoColumns(left, right, width, minWidth = 92) {
  if (width < minWidth) return [...left, "", ...right];
  const gap = 3;
  const col = Math.floor((width - gap) / 2);
  const lines = [];
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) {
    const a = truncateAnsi(left[i] ?? "", col);
    const b = truncateAnsi(right[i] ?? "", col);
    lines.push(`${padRight(a, col)}${" ".repeat(gap)}${b}`.trimEnd());
  }
  return lines;
}

function quotaRiskSummary(quota) {
  let windows = 0;
  let atRisk = 0;
  let watch = 0;
  let exhausted = 0;
  let nearest;
  for (const report of quota?.reports ?? []) {
    for (const group of quotaDisplayGroups(report)) {
      for (const limit of group.limits) {
        windows++;
        const fraction = usedFraction(limit.amount ?? {});
        const status = limit.intelligence?.status;
        if (status === "exhausted" || Number(fraction) >= 1) exhausted++;
        else if (status === "at-risk") atRisk++;
        else if (status === "watch" || Number(fraction) >= 0.8) watch++;
        const projected = Number(limit.intelligence?.projectedExhaustAt);
        if (Number.isFinite(projected) && (nearest === undefined || projected < nearest)) nearest = projected;
      }
    }
  }
  return { windows, atRisk, watch, exhausted, nearest };
}

function renderOverview(context, width) {
  const { stats, statsState, quota } = context;
  const state = statsStateText({ stats, ...statsState });
  const left = [sectionTitle("REQUEST / CACHE", Math.max(40, Math.floor(width / 2)), state)];
  if (!stats) {
    if (statsState?.refreshing) {
      left.push(style.dim("  First load may take a while."), style.dim("  Syncing OMP session history and calculating stats…"));
    } else {
      left.push(style.dim("  Stats have not been loaded yet."));
    }
  } else {
    const o = stats.overall ?? {};
    left.push(
      `  Requests      ${compactNumber(Number(o.totalRequests || 0)).padEnd(9)} Errors      ${percent(Number(o.errorRate || 0))}`,
      `  Input         ${compactNumber(Number(o.totalInputTokens || 0)).padEnd(9)} Output      ${compactNumber(Number(o.totalOutputTokens || 0))}`,
      `  Cache rate    ${percent(Number(o.cacheRate || 0)).padEnd(9)} API est.    ${formatMoney(Number(o.totalCost))}`,
      `  Avg TTFT      ${formatDuration(Number(o.avgTtft)).padEnd(9)} Latency     ${formatDuration(Number(o.avgDuration))}`,
      `  Avg TPS       ${Number.isFinite(Number(o.avgTokensPerSecond)) ? Number(o.avgTokensPerSecond).toFixed(1) : "-"}`,
    );
    const series = stats.timeSeries ?? [];
    if (series.length) {
      const requests = series.map(point => point?.totalRequests ?? point?.requests ?? point?.count ?? 0);
      const errors = series.map(point => point?.failedRequests ?? point?.errors ?? 0);
      left.push("", sectionTitle("TRAFFIC", Math.max(40, Math.floor(width / 2))), `  req ${sparkline(requests)}  err ${sparkline(errors)}`);
    }
  }

  const risk = quotaRiskSummary(quota);
  const right = [sectionTitle("QUOTA RISK", Math.max(40, Math.floor(width / 2)))];
  if (!risk.windows) right.push(style.dim("  Waiting for quota data…"));
  else {
    right.push(
      `  Windows       ${String(risk.windows).padEnd(9)} Exhausted   ${risk.exhausted ? style.red(String(risk.exhausted)) : "0"}`,
      `  At risk       ${risk.atRisk ? style.red(String(risk.atRisk)) : "0"}          Watch       ${risk.watch ? style.yellow(String(risk.watch)) : "0"}`,
      `  Nearest ETA   ${risk.nearest ? formatAge(Date.now(), risk.nearest) : "-"}`,
    );
  }

  const models = modelPerformanceRows(stats).slice(0, 5);
  right.push("", sectionTitle("TOP MODELS", Math.max(40, Math.floor(width / 2))));
  if (!models.length) right.push(style.dim("  No model statistics reported."));
  else for (const row of models) {
    const label = `${providerLabel(row.provider)}/${row.model}`;
    right.push(`  ${label.slice(0, 31).padEnd(31)} ${compactNumber(row.totalRequests).padStart(6)} req  ${percent(row.errorRate).padStart(6)} err`);
  }
  return twoColumns(left, right, width);
}

function intelligenceLine(limit) {
  const intel = limit?.intelligence;
  if (!intel || (intel.sampleCount ?? 0) < 2 || intel.burnPerHour === undefined) return style.dim("history: collecting samples · burn - · ETA -");
  const burn = formatPercentPerHour(intel.burnPerHour);
  const eta = formatHours(intel.etaHours);
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
  const lines = [sectionTitle("QUOTA / RUNWAY", width)];
  if (!reports.length) {
    lines.push(quotaRefreshing ? style.dim("  Waiting for quota results…") : style.dim("  No quota data available"));
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
    lines.push(`  ${style.bold(providerLabel(provider))}${state ? `  ${state}` : ""}`);
    providerReports.sort((a, b) => accountLabel(a, "").localeCompare(accountLabel(b, ""))).forEach((report, index) => {
      const identity = accountLabel(report, providerReports.length > 1 ? `Account ${index + 1}` : "Account");
      const plan = planLabel(report);
      lines.push(`    ${style.cyan(identity)}${plan ? style.dim(` · ${plan}`) : ""}`);
      const groups = quotaDisplayGroups(report);
      const hasLimits = groups.some(group => group.limits.length > 0);
      if (!hasLimits) { lines.push(style.dim("      no quota windows reported")); return; }
      const groupedAntigravity = report.provider === "google-antigravity" && groups.some(group => group.label);
      for (const group of groups) {
        if (groupedAntigravity && group.label) lines.push(`      ${style.bold(group.label)}`);
        for (const limit of group.limits) {
          const fraction = usedFraction(limit.amount ?? {});
          const windowLabel = String(limit.window?.label || limit.scope?.windowId || limit.id || "limit");
          const labelWidth = groupedAntigravity ? 18 : 20;
          const label = windowLabel.slice(0, labelWidth).padEnd(labelWidth);
          const barWidth = Math.max(6, Math.min(18, width - (groupedAntigravity ? 50 : 48)));
          const bar = progressBar(fraction, barWidth);
          const pct = percent(fraction).padStart(6);
          const reset = formatReset(limit.window?.resetsAt).padStart(13);
          const indent = groupedAntigravity ? "        " : "      ";
          lines.push(`${indent}${label} ${bar} ${quotaColor(fraction, pct)} ${reset}`.trimEnd());
          lines.push(`${indent}${" ".repeat(Math.min(labelWidth + 1, 21))}${intelligenceLine(limit)}`.trimEnd());
        }
      }
    });
  }
  return lines;
}

function renderModels(context, width) {
  const rows = modelPerformanceRows(context.stats);
  const lines = [sectionTitle("MODEL PERFORMANCE", width)];
  lines.push(style.dim("  API est. is OMP's API-equivalent cost estimate; subscription billing may differ."));
  if (!rows.length) { lines.push(style.dim("  No per-model statistics reported.")); return lines; }
  if (width < 90) {
    for (const row of rows) {
      lines.push("", `  ${style.bold(providerLabel(row.provider))} · ${row.model}`);
      lines.push(`    req ${compactNumber(row.totalRequests)} · err ${percent(row.errorRate)} · TTFT ${formatDuration(row.avgTtft)} · TPS ${Number.isFinite(row.avgTokensPerSecond) ? row.avgTokensPerSecond.toFixed(1) : "-"}`);
      lines.push(style.dim(`    latency ${formatDuration(row.avgDuration)} · API est. ${formatMoney(row.totalCost)}`));
    }
    return lines;
  }
  lines.push(style.dim("  Provider           Model                         Req    Err    TTFT     TPS  Latency  API est."));
  for (const row of rows) {
    const provider = providerLabel(row.provider).slice(0, 16).padEnd(16);
    const model = row.model.slice(0, 28).padEnd(28);
    const req = compactNumber(row.totalRequests).padStart(6);
    const err = percent(row.errorRate).padStart(6);
    const ttft = formatDuration(row.avgTtft).padStart(7);
    const tps = (Number.isFinite(row.avgTokensPerSecond) ? row.avgTokensPerSecond.toFixed(1) : "-").padStart(7);
    const latency = formatDuration(row.avgDuration).padStart(8);
    const cost = formatMoney(row.totalCost).padStart(9);
    lines.push(`  ${provider} ${model} ${req} ${err} ${ttft} ${tps} ${latency} ${cost}`);
  }
  return lines;
}

function renderCache(context, width) {
  const stats = context.stats;
  const lines = [sectionTitle("CACHE EFFICIENCY", width)];
  if (!stats) { lines.push(style.dim("  Stats have not been loaded yet.")); return lines; }
  const o = stats.overall ?? {};
  lines.push(
    `  Overall hit    ${percent(Number(o.cacheRate || 0)).padEnd(10)} Read       ${compactNumber(Number(o.totalCacheReadTokens || 0))}`,
    `  Cache write    ${compactNumber(Number(o.totalCacheWriteTokens || 0)).padEnd(10)} Savings    ${percent(Number(o.cacheSavings || 0))}`,
  );
  const providers = aggregateCacheByProvider(stats.byModel);
  if (providers.length) {
    lines.push("", sectionTitle("BY PROVIDER", width));
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
    lines.push("", sectionTitle("BY MODEL", width));
    if (width < 90) {
      for (const row of models) {
        const rate = Number(row.cacheRate || 0);
        lines.push(`  ${providerLabel(String(row.provider ?? "unknown"))}/${String(row.model ?? "unknown")}`);
        lines.push(`    req ${compactNumber(Number(row.totalRequests || 0))} · hit ${percent(rate)} · read ${compactNumber(Number(row.totalCacheReadTokens || 0))} · write ${compactNumber(Number(row.totalCacheWriteTokens || 0))}`);
      }
    } else {
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
  }
  return lines;
}

function renderAgents(context, width) {
  const rows = context.stats?.byAgentType ?? [];
  const lines = [sectionTitle("AGENT / ROLE ATTRIBUTION", width)];
  if (!rows.length) {
    lines.push(style.dim("  This OMP stats snapshot did not report byAgentType data."));
    return lines;
  }
  const totalTokens = rows.reduce((sum, row) => sum + Number(row.totalInputTokens || 0) + Number(row.totalOutputTokens || 0), 0);
  lines.push(style.dim("  Agent / role                  Req   Share      Input     Output    Cache    API est."));
  for (const row of [...rows].sort((a, b) => Number(b.totalRequests || 0) - Number(a.totalRequests || 0))) {
    const name = String(row.agentType ?? row.type ?? "unknown").slice(0, 28).padEnd(28);
    const req = compactNumber(Number(row.totalRequests || 0)).padStart(6);
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
  const lines = [sectionTitle("RUNTIME EVENTS", width)];
  lines.push(style.dim("  In-memory only · newest first · no persistent event log"));
  if (!events.length) { lines.push(style.dim("  No events yet.")); return lines; }
  for (const event of [...events].reverse()) {
    const level = String(event.level || "info").toUpperCase().padEnd(5);
    let label = style.dim(level);
    if (event.level === "error") label = style.red(level);
    else if (event.level === "warn") label = style.yellow(level);
    else if (event.level === "ok") label = style.green(level);
    lines.push(truncateAnsi(`  ${formatClock(event.at)}  ${label}  ${event.message}`, width));
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
