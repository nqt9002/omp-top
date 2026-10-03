import { aggregateCacheByProvider, cacheRate, sortModels } from "./stats.mjs";
import { modelPerformanceRows } from "./intelligence.mjs";
import { buildOverviewIntelligence } from "./overview-intelligence.mjs";
import { quotaDisplayGroups } from "./quota.mjs";
import { joinColumns, renderMetricGrid, sectionTitle } from "./layout.mjs";
import { t } from "./i18n.mjs";
import {
  style, compactNumber, percent, providerLabel, usedFraction, quotaColor, cacheColor,
  progressBar, formatReset, formatClock, formatAge, formatDuration, formatMoney,
  formatHours, formatPercentPerHour, formatUntil, sparkline, truncateAnsi, padRight,
} from "./format.mjs";

export const VIEWS = [
  { id: "overview", key: "1", labelKey: "view.overview", shortKey: "view.overview.short" },
  { id: "quota", key: "2", labelKey: "view.quota", shortKey: "view.quota.short" },
  { id: "models", key: "3", labelKey: "view.models", shortKey: "view.models.short" },
  { id: "cache", key: "4", labelKey: "view.cache", shortKey: "view.cache.short" },
  { id: "agents", key: "5", labelKey: "view.agents", shortKey: "view.agents.short" },
  { id: "events", key: "6", labelKey: "view.events", shortKey: "view.events.short" },
];

export function viewLabel(viewOrId) {
  const view = typeof viewOrId === "string" ? VIEWS.find(item => item.id === viewOrId) : viewOrId;
  return view ? t(view.labelKey) : String(viewOrId ?? "");
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
  if (refreshing && !stats) return style.yellow(t("state.calculating", { elapsed }));
  if (refreshing && stats) return style.yellow(t("state.refreshingPrevious", { elapsed }));
  if (error && stats) return style.red(t("state.refreshFailedPrevious"));
  if (error) return style.red(t("state.unavailable"));
  if (stats && updatedAt) return style.green(t("state.fresh", { time: formatClock(updatedAt) }));
  return style.dim(t("state.notLoaded"));
}

function providerStateText(state, refreshing) {
  if (!state) return refreshing ? style.yellow(t("state.providerRefreshing", { stamp: "" })) : "";
  const stamp = state.updatedAt ? t("state.ago", { age: formatAge(state.updatedAt) }) : "";
  if (state.status === "fresh") return style.green(t("state.providerFresh", { stamp }));
  if (state.status === "refreshing") return style.yellow(t("state.providerRefreshing", { stamp: state.updatedAt ? t("state.last", { time: formatClock(state.updatedAt) }) : "" }));
  if (state.status === "error") return style.red(t("state.providerStaleError", { stamp }));
  return style.dim(t("state.providerStale", { stamp }));
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

function severityStyle(severity, text) {
  if (severity === "critical") return style.red(style.bold(text));
  if (severity === "warning") return style.yellow(style.bold(text));
  if (severity === "watch") return style.yellow(text);
  return style.dim(text);
}

function confidenceLabel(value) {
  return t(`overview.confidence.${value || "low"}`);
}

function severityLabel(value) {
  return t(`overview.severity.${value || "watch"}`);
}

function viewHint(key) {
  const view = VIEWS.find(item => item.key === String(key));
  return t("overview.openView", { key, view: viewLabel(view) });
}

function ratioText(value) {
  return Number.isFinite(value) ? Number(value).toFixed(value >= 10 ? 1 : 2) : "-";
}

function ppText(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(value * 100 >= 10 ? 0 : 1) : "-";
}

function alertTitle(alert) {
  if (alert.kind === "quota-exhausted") {
    return t("overview.alert.quotaExhausted", { provider: providerLabel(alert.provider) });
  }
  if (alert.kind === "quota-runway") {
    return t("overview.alert.quotaRunway", {
      provider: providerLabel(alert.provider),
      eta: formatHours(alert.quota?.etaHours),
    });
  }
  if (alert.kind === "quota-acceleration") {
    return t("overview.alert.quotaAcceleration", {
      provider: providerLabel(alert.provider),
      ratio: ratioText(alert.quota?.accelerationRatio),
    });
  }
  if (alert.kind === "model-failure") {
    return t("overview.alert.modelFailure", { provider: providerLabel(alert.provider), model: alert.model });
  }
  if (alert.kind === "cache-low") {
    return t("overview.alert.cacheLow", { provider: providerLabel(alert.provider), model: alert.model, rate: percent(alert.cacheRate) });
  }
  if (alert.kind === "slow-ttft") {
    return t("overview.alert.slowTtft", { provider: providerLabel(alert.provider), model: alert.model });
  }
  if (alert.kind === "low-tps") {
    return t("overview.alert.lowTps", { provider: providerLabel(alert.provider), model: alert.model });
  }
  if (alert.kind === "agent-concentration") {
    return t("overview.alert.agentConcentration", { agent: alert.agentType, share: percent(alert.share) });
  }
  if (alert.kind === "runtime-error") {
    return t("overview.alert.runtimeError", { count: alert.errors });
  }
  return String(alert.kind);
}

function alertDetail(alert) {
  if (alert.kind === "quota-exhausted" || alert.kind === "quota-runway") {
    return t("overview.detail.quota", {
      limit: alert.quota?.groupLabel || alert.quota?.label || "quota",
      used: percent(alert.quota?.usedFraction),
      reset: Number.isFinite(alert.quota?.resetsAt) ? formatUntil(alert.quota.resetsAt) : "-",
    });
  }
  if (alert.kind === "quota-acceleration") {
    return t("overview.detail.quotaAcceleration", {
      recent: formatPercentPerHour(alert.quota?.burnPerHour),
      baseline: formatPercentPerHour(alert.quota?.baselineBurnPerHour),
    });
  }
  if (alert.kind === "model-failure") {
    return t("overview.detail.modelFailure", {
      failed: alert.failedRequests,
      total: alert.totalRequests,
      rate: percent(alert.errorRate),
      confidence: confidenceLabel(alert.confidence),
    });
  }
  if (alert.kind === "cache-low") {
    return t("overview.detail.cacheLow", {
      gap: ppText(alert.gap),
      requests: compactNumber(alert.totalRequests),
    });
  }
  if (alert.kind === "slow-ttft") {
    return t("overview.detail.slowTtft", {
      ttft: formatDuration(alert.avgTtft),
      ratio: ratioText(alert.ratio),
      requests: compactNumber(alert.totalRequests),
    });
  }
  if (alert.kind === "low-tps") {
    return t("overview.detail.lowTps", {
      tps: Number.isFinite(alert.avgTokensPerSecond) ? Number(alert.avgTokensPerSecond).toFixed(1) : "-",
      ratio: ratioText(alert.ratio),
      requests: compactNumber(alert.totalRequests),
    });
  }
  if (alert.kind === "agent-concentration") {
    return t("overview.detail.agentConcentration", { tokens: compactNumber(alert.tokens) });
  }
  if (alert.kind === "runtime-error") {
    return t("overview.detail.runtimeError", { warnings: alert.warnings });
  }
  return "";
}

function alertAttribution(alert) {
  if (!alert.attribution) return "";
  if (alert.attribution.type === "direct") {
    return t("overview.attribution.direct", { model: alert.attribution.model });
  }
  return `${t("overview.attribution.workload", {
    provider: providerLabel(alert.provider),
    model: alert.attribution.model,
    share: percent(alert.attribution.share),
  })} · ${t("overview.attribution.caveat")}`;
}

function alertCorrelation(alert) {
  const correlation = alert.correlation;
  if (!correlation) return "";
  const cache = Number.isFinite(correlation.cacheRate) ? percent(correlation.cacheRate) : "-";
  const ratio = ratioText(correlation.requestTrendRatio);
  if (correlation.cacheLow && correlation.workloadElevated) {
    return t("overview.correlation.both", { cache, ratio });
  }
  if (correlation.cacheLow) return t("overview.correlation.cache", { cache });
  if (correlation.workloadElevated) return t("overview.correlation.workload", { ratio });
  return "";
}

function alertAction(alert) {
  if (alert.severity !== "critical" && alert.severity !== "warning") return "";
  if (alert.kind === "quota-exhausted" || alert.kind === "quota-runway" || alert.kind === "quota-acceleration") {
    const target = alert.attribution?.type === "direct" ? alert.attribution.model : providerLabel(alert.provider);
    return t("overview.action.quota", { target });
  }
  if (alert.kind === "model-failure") return t("overview.action.modelFailure");
  if (alert.kind === "cache-low") return t("overview.action.cache");
  if (alert.kind === "runtime-error") return t("overview.action.runtime");
  return "";
}

function renderAttention(intelligence, width) {
  const lines = [sectionTitle(t("section.attention"), width)];
  if (!intelligence.alerts.length) {
    if (!intelligence.coverage.stats && !intelligence.coverage.quota) {
      lines.push(` ${style.yellow("↻")} ${t("overview.assessing")}`);
    } else if (!intelligence.coverage.stats || !intelligence.coverage.quota) {
      lines.push(` ${style.yellow("◐")} ${t("overview.partial")}`);
    } else {
      lines.push(` ${style.green("✓")} ${style.bold(t("overview.allClear"))}`);
      lines.push(style.dim(`   ${t("overview.allClearDetail")}`));
    }
    return lines;
  }

  for (const alert of intelligence.alerts) {
    const badge = severityStyle(alert.severity, severityLabel(alert.severity));
    const title = alertTitle(alert);
    lines.push(truncateAnsi(` ${badge}  ${title}  ${style.dim(viewHint(alert.viewKey))}`, width));
    const detail = alertDetail(alert);
    if (detail) lines.push(truncateAnsi(`   ${detail}`, width));
    const correlation = alertCorrelation(alert);
    if (correlation) lines.push(truncateAnsi(`   ${style.yellow(correlation)}`, width));
    const attribution = alertAttribution(alert);
    if (attribution) lines.push(truncateAnsi(`   ${style.dim(attribution)}`, width));
    const action = alertAction(alert);
    if (action) lines.push(truncateAnsi(`   ${style.bold(action)}`, width));
  }
  return lines;
}

function capacityLine(summary) {
  const row = summary.worst;
  const provider = providerLabel(summary.provider);
  const reset = Number.isFinite(summary.nextResetAt) ? formatUntil(summary.nextResetAt) : "-";
  if (!row) return provider;
  if (row.status === "exhausted" || Number(row.usedFraction) >= 1) {
    return style.red(t("overview.capacity.exhausted", { provider, reset }));
  }
  if (row.status === "at-risk") {
    return style.yellow(t("overview.capacity.risk", {
      provider,
      used: percent(row.usedFraction),
      eta: formatHours(row.etaHours),
      reset,
    }));
  }
  return t("overview.capacity.healthy", { provider, used: percent(row.usedFraction), reset });
}

function renderCapacity(intelligence, width) {
  const lines = [sectionTitle(t("section.capacity"), width)];
  if (!intelligence.capacity.length) {
    lines.push(style.dim(t("overview.capacity.none")));
    return lines;
  }
  for (const summary of intelligence.capacity.slice(0, 4)) {
    lines.push(` ${capacityLine(summary)}`);
    if (summary.exhaustedCount || summary.atRiskCount || summary.watchCount) {
      lines.push(style.dim(`   ${t("overview.capacity.counts", {
        exhausted: summary.exhaustedCount,
        risk: summary.atRiskCount,
        watch: summary.watchCount,
      })}`));
    }
    if (summary.resetCreditsAvailable > 0) {
      lines.push(style.cyan(`   ${t("overview.capacity.resetCredits", { count: summary.resetCreditsAvailable })}`));
    }
    if (summary.attribution) {
      const attribution = summary.attribution.type === "direct"
        ? t("overview.attribution.direct", { model: summary.attribution.model })
        : t("overview.attribution.workload", {
            provider: providerLabel(summary.provider),
            model: summary.attribution.model,
            share: percent(summary.attribution.share),
          });
      lines.push(style.dim(`   ${attribution}`));
    }
  }
  lines.push(style.dim(` ${viewHint("2")}`));
  return lines;
}

function renderReliability(intelligence, width) {
  const lines = [sectionTitle(t("section.modelReliability"), width)];
  lines.push(t("overview.model.summary", {
    active: intelligence.reliability.activeModels,
    unhealthy: intelligence.reliability.unhealthyModels,
  }));
  if (!intelligence.reliability.failures.length) {
    lines.push(style.green(` ✓ ${t("overview.model.healthy")}`));
  } else {
    for (const row of intelligence.reliability.failures.slice(0, 3)) {
      const text = t("overview.model.failure", {
        provider: providerLabel(row.provider),
        model: row.model,
        failed: row.failedRequests,
        total: row.totalRequests,
        confidence: confidenceLabel(row.confidence),
      });
      lines.push(` ${severityStyle(row.severity, "●")} ${text}`);
    }
  }
  lines.push(style.dim(` ${viewHint("3")}`));
  return lines;
}

function renderCacheSignals(intelligence, width) {
  const lines = [sectionTitle(t("section.cacheSignals"), width)];
  lines.push(t("overview.cache.overall", { rate: percent(intelligence.cache.overallCacheRate) }));
  const low = intelligence.cache.lowModels[0];
  if (low) {
    lines.push(` ${severityStyle(low.severity, "●")} ${t("overview.cache.lowest", { model: low.model, rate: percent(low.cacheRate) })}`);
  } else {
    lines.push(style.green(` ✓ ${t("overview.cache.noEvidence")}`));
  }
  const uncached = intelligence.cache.highestUncachedModel;
  if (uncached && Number(uncached.totalInputTokens || 0) > 0) {
    lines.push(t("overview.cache.uncached", {
      model: uncached.model,
      tokens: compactNumber(Number(uncached.totalInputTokens || 0)),
    }));
  }
  lines.push(style.dim(` ${viewHint("4")}`));
  return lines;
}

function renderWorkload(intelligence, width) {
  const lines = [sectionTitle(t("section.workload"), width)];
  if (!intelligence.agents.shares.length) {
    lines.push(style.dim(t("overview.workload.none")));
    return lines;
  }
  for (const row of intelligence.agents.shares.slice(0, 4)) {
    lines.push(t("overview.workload.row", { agent: row.agentType, share: percent(row.share) }));
  }
  lines.push(style.dim(` ${viewHint("5")}`));
  return lines;
}

function renderActivity(intelligence, width) {
  const lines = [sectionTitle(t("section.activity"), width)];
  if (intelligence.activity.errors || intelligence.activity.warnings) {
    lines.push(t("overview.activity.summary", {
      errors: intelligence.activity.errors,
      warnings: intelligence.activity.warnings,
    }));
    if (intelligence.activity.notable?.message) {
      lines.push(truncateAnsi(t("overview.activity.latest", { message: intelligence.activity.notable.message }), width));
    }
  } else {
    lines.push(style.green(` ✓ ${t("overview.activity.clear")}`));
  }
  lines.push(style.dim(` ${viewHint("6")}`));
  return lines;
}

function renderSystemContext(context, intelligence, width) {
  const lines = [sectionTitle(t("section.systemContext"), width, statsStateText({ stats: context.stats, ...context.statsState }))];
  if (!context.stats) {
    lines.push(style.dim(context.statsState?.refreshing ? t("overview.firstLoad") : t("overview.statsNotLoaded")));
    return lines;
  }
  const o = context.stats.overall ?? {};
  const items = [
    t("overview.system.requests", { value: compactNumber(Number(o.totalRequests || 0)) }),
    t("overview.system.errors", { value: percent(Number(o.errorRate || 0)) }),
    t("overview.system.ttft", { value: formatDuration(Number(o.avgTtft)) }),
    t("overview.system.tps", { value: Number.isFinite(Number(o.avgTokensPerSecond)) ? Number(o.avgTokensPerSecond).toFixed(1) : "-" }),
    t("overview.system.cost", { value: formatMoney(Number(o.totalCost)) }),
  ];
  lines.push(` ${items.join(" · ")}`);
  const trend = intelligence.requestTrend?.ratio;
  if (Number.isFinite(trend) && trend >= 1.5) {
    lines.push(style.yellow(` ${t("overview.system.trafficElevated", { ratio: ratioText(trend) })}`));
  } else {
    lines.push(style.dim(` ${t("overview.system.trafficNormal")}`));
  }
  return lines;
}

function renderOverview(context, width) {
  const intelligence = buildOverviewIntelligence({
    stats: context.stats,
    quota: context.quota,
    events: context.events,
  });

  const capacityWidth = width >= 112 ? Math.floor((width - 4) / 2) : width;
  const reliabilityWidth = width >= 112 ? width - 4 - capacityWidth : width;
  const cacheWidth = capacityWidth;
  const workloadWidth = reliabilityWidth;

  return [
    ...renderAttention(intelligence, width),
    "",
    ...joinColumns(
      renderCapacity(intelligence, capacityWidth),
      renderReliability(intelligence, reliabilityWidth),
      width,
      { gap: 4, minWidth: 112 },
    ),
    "",
    ...joinColumns(
      renderCacheSignals(intelligence, cacheWidth),
      renderWorkload(intelligence, workloadWidth),
      width,
      { gap: 4, minWidth: 112 },
    ),
    "",
    ...renderActivity(intelligence, width),
    "",
    ...renderSystemContext(context, intelligence, width),
  ];
}

function tableCell(value, width) {
  return padRight(truncateAnsi(String(value ?? ""), Math.max(1, width)), Math.max(1, width));
}

function intelligenceLine(limit) {
  const intel = limit?.intelligence;
  const burnValue = Number.isFinite(intel?.recentBurnPerHour) ? intel.recentBurnPerHour : intel?.burnPerHour;
  if (!intel || (intel.sampleCount ?? 0) < 2 || !Number.isFinite(burnValue)) return style.dim(t("quota.collecting"));
  const burn = formatPercentPerHour(burnValue);
  const etaValue = Number.isFinite(intel.recentEtaHours) ? intel.recentEtaHours : intel.etaHours;
  const eta = intel.status === "exhausted" ? t("time.now") : formatHours(etaValue);
  const sustainable = formatPercentPerHour(intel.sustainablePerHour);
  const paceValue = Number.isFinite(intel.recentPaceRatio) ? intel.recentPaceRatio : intel.paceRatio;
  const pace = Number.isFinite(paceValue) ? `${paceValue.toFixed(2)}×` : "-";
  let text = t("quota.intelligence", { burn, eta, sustainable, pace });
  if (Number.isFinite(intel.baselineBurnPerHour) && Number.isFinite(intel.accelerationRatio)) {
    text += t("quota.intelligenceTrend", {
      baseline: formatPercentPerHour(intel.baselineBurnPerHour),
      ratio: ratioText(intel.accelerationRatio),
    });
  }
  if (intel.status === "exhausted" || intel.status === "at-risk") return style.red(text);
  if (intel.status === "watch" || intel.burnTrend === "spike" || intel.burnTrend === "elevated") return style.yellow(text);
  return style.dim(text);
}

function renderQuota(context, width) {
  const { quota, providerStates = new Map(), quotaRefreshing } = context;
  const reports = quota?.reports ?? [];
  const lines = [sectionTitle(t("section.quotaRunway"), width)];
  if (!reports.length) {
    lines.push(quotaRefreshing ? style.dim(t("quota.waiting")) : style.dim(t("quota.none")));
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
      const identity = accountLabel(report, providerReports.length > 1 ? `${t("common.account")} ${index + 1}` : t("common.account"));
      const plan = planLabel(report);
      lines.push(`   ${style.cyan(identity)}${plan ? style.dim(` · ${plan}`) : ""}`);
      const groups = quotaDisplayGroups(report);
      const hasLimits = groups.some(group => group.limits.length > 0);
      if (!hasLimits) { lines.push(style.dim(t("quota.noWindows"))); return; }
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
  const lines = [sectionTitle(t("section.modelPerformance"), width)];
  lines.push(style.dim(t("models.apiNote")));
  if (!rows.length) { lines.push(style.dim(t("models.none"))); return lines; }
  if (width < 96) {
    for (const row of rows) {
      lines.push("", ` ${style.bold(providerLabel(row.provider))} · ${row.model}`);
      lines.push(`   ${t("common.req")} ${compactNumber(row.totalRequests)} · ${t("common.err")} ${percent(row.errorRate)} · TTFT ${formatDuration(row.avgTtft)} · TPS ${Number.isFinite(row.avgTokensPerSecond) ? row.avgTokensPerSecond.toFixed(1) : "-"}`);
      lines.push(style.dim(`   ${t("common.latency")} ${formatDuration(row.avgDuration)} · ${t("metric.apiEst")} ${formatMoney(row.totalCost)}`));
    }
    return lines;
  }

  const providerWidth = width >= 132 ? 20 : 16;
  const modelWidth = Math.max(18, width - providerWidth - 56);
  lines.push(style.dim(`  ${tableCell(t("metric.provider"), providerWidth)} ${tableCell(t("metric.model"), modelWidth)} ${t("metric.req").padStart(7)} ${t("metric.err").padStart(7)} ${t("metric.ttft").padStart(8)} ${t("metric.tps").padStart(7)} ${t("metric.latency").padStart(8)} ${t("metric.apiEst").padStart(10)}`));
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
  const lines = [sectionTitle(t("section.cacheEfficiency"), width)];
  if (!stats) { lines.push(style.dim(t("overview.statsNotLoaded"))); return lines; }
  const o = stats.overall ?? {};
  lines.push(...renderMetricGrid([
    { label: style.dim(t("metric.overallHit")), value: cacheColor(Number(o.cacheRate || 0), percent(Number(o.cacheRate || 0))) },
    { label: style.dim(t("metric.cacheRead")), value: compactNumber(Number(o.totalCacheReadTokens || 0)) },
    { label: style.dim(t("metric.cacheWrite")), value: compactNumber(Number(o.totalCacheWriteTokens || 0)) },
    { label: style.dim(t("metric.savings")), value: percent(Number(o.cacheSavings || 0)) },
  ], width));

  const providers = aggregateCacheByProvider(stats.byModel);
  if (providers.length) {
    lines.push("", sectionTitle(t("section.byProvider"), width));
    if (width < 68) {
      for (const row of providers) {
        lines.push(` ${style.bold(providerLabel(row.provider))}`);
        lines.push(`   ${t("common.req")} ${compactNumber(row.totalRequests)} · ${t("common.hit")} ${percent(row.cacheRate)} · ${t("common.read")} ${compactNumber(row.totalCacheReadTokens)} · ${t("common.write")} ${compactNumber(row.totalCacheWriteTokens)}`);
      }
    } else {
      lines.push(style.dim(`  ${tableCell(t("metric.provider"), 24)} ${t("metric.req").padStart(7)} ${t("metric.hit").padStart(7)} ${t("metric.read").padStart(9)} ${t("metric.write").padStart(9)}`));
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
    lines.push("", sectionTitle(t("section.byModel"), width));
    if (width < 96) {
      for (const row of models) {
        const rate = Number(row.cacheRate || 0);
        lines.push(` ${providerLabel(String(row.provider ?? "unknown"))}/${String(row.model ?? "unknown")}`);
        lines.push(`   ${t("common.req")} ${compactNumber(Number(row.totalRequests || 0))} · ${t("common.hit")} ${percent(rate)} · ${t("common.read")} ${compactNumber(Number(row.totalCacheReadTokens || 0))} · ${t("common.write")} ${compactNumber(Number(row.totalCacheWriteTokens || 0))}`);
      }
    } else {
      const providerWidth = width >= 132 ? 20 : 16;
      const modelWidth = Math.max(18, width - providerWidth - 47);
      lines.push(style.dim(`  ${tableCell(t("metric.provider"), providerWidth)} ${tableCell(t("metric.model"), modelWidth)} ${t("metric.req").padStart(7)} ${t("metric.hit").padStart(7)} ${t("metric.read").padStart(8)} ${t("metric.write").padStart(8)} ${t("metric.save").padStart(7)}`));
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
  const lines = [sectionTitle(t("section.agentAttribution"), width)];
  if (!rows.length) {
    lines.push(style.dim(t("agents.none")));
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
      lines.push(`   ${t("common.req")} ${compactNumber(Number(row.totalRequests || 0))} · ${t("common.share")} ${share} · ${t("common.cache")} ${cache}`);
      lines.push(style.dim(`   ${t("common.input")} ${compactNumber(Number(row.totalInputTokens || 0))} · ${t("common.output")} ${compactNumber(Number(row.totalOutputTokens || 0))} · ${t("metric.apiEst")} ${formatMoney(Number(row.totalCost))}`));
    }
    return lines;
  }

  const nameWidth = Math.max(20, width - 57);
  lines.push(style.dim(`  ${tableCell(t("metric.agentRole"), nameWidth)} ${t("metric.req").padStart(7)} ${t("metric.share").padStart(7)} ${t("metric.input").padStart(9)} ${t("metric.output").padStart(9)} ${t("view.cache").padStart(7)} ${t("metric.apiEst").padStart(10)}`));
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
  const lines = [sectionTitle(t("section.runtimeEvents"), width)];
  lines.push(style.dim(t("events.note")));
  if (!events.length) { lines.push(style.dim(t("events.none"))); return lines; }
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
