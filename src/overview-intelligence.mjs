import { modelPerformanceRows } from "./intelligence.mjs";
import { quotaDisplayGroups } from "./quota.mjs";
import { aggregateCacheByProvider, cacheRate } from "./stats.mjs";
import { usedFraction } from "./format.mjs";

const HOUR_MS = 60 * 60 * 1000;
const SEVERITY = { critical: 4, warning: 3, watch: 2, info: 1 };
const CACHE_MIN_REQUESTS = 5;
const CACHE_MIN_TOKENS = 1_000;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

function modelKey(provider, model) { return `${provider}\0${model}`; }

function confidenceForRequests(requests) {
  if (requests >= 20) return "high";
  if (requests >= 5) return "medium";
  return "low";
}

function tokenTotal(row) {
  return Number(row?.totalInputTokens || 0)
    + Number(row?.totalOutputTokens || 0)
    + Number(row?.totalCacheReadTokens || 0)
    + Number(row?.totalCacheWriteTokens || 0);
}

function cacheEvidence(row) {
  return Number(row?.totalCacheReadTokens || 0) + Number(row?.totalCacheWriteTokens || 0) > 0;
}

function rowCacheRate(row) {
  if (Number.isFinite(Number(row?.cacheRate))) return clamp01(Number(row.cacheRate));
  return cacheRate(Number(row?.totalInputTokens || 0), Number(row?.totalCacheReadTokens || 0));
}

function requestTrend(points, { recentHours = 3, baselineHours = 9 } = {}) {
  const byTimestamp = new Map();
  for (const point of points ?? []) {
    const timestamp = finite(point?.timestamp);
    if (timestamp === undefined) continue;
    byTimestamp.set(timestamp, (byTimestamp.get(timestamp) ?? 0) + Math.max(0, Number(point?.requests || 0)));
  }
  const valid = [...byTimestamp.entries()]
    .map(([timestamp, requests]) => ({ timestamp, requests }))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (valid.length < 3) return undefined;
  const latest = valid.at(-1).timestamp;
  const recentCutoff = latest - recentHours * HOUR_MS;
  const baselineCutoff = recentCutoff - baselineHours * HOUR_MS;
  const recent = valid.filter(point => point.timestamp > recentCutoff && point.timestamp <= latest);
  const baseline = valid.filter(point => point.timestamp > baselineCutoff && point.timestamp <= recentCutoff);
  if (baseline.length < 2) return undefined;

  const recentPerHour = recent.reduce((sum, point) => sum + point.requests, 0) / recentHours;
  const baselinePerHour = baseline.reduce((sum, point) => sum + point.requests, 0) / baselineHours;
  const ratio = baselinePerHour >= 0.5 ? recentPerHour / baselinePerHour : undefined;
  return {
    recentPerHour,
    baselinePerHour,
    ratio,
    latestTimestamp: latest,
    recentSamples: recent.length,
    baselineSamples: baseline.length,
  };
}

function modelFacts(stats) {
  const models = modelPerformanceRows(stats);
  const providerCache = new Map(aggregateCacheByProvider(models).map(row => [row.provider, row]));
  const byProvider = new Map();

  for (const model of models) {
    const bucket = byProvider.get(model.provider) ?? [];
    bucket.push(model);
    byProvider.set(model.provider, bucket);
  }

  const seriesByModel = new Map();
  const seriesByProvider = new Map();
  for (const point of stats?.modelSeries ?? []) {
    const provider = String(point?.provider ?? "unknown");
    const model = String(point?.model ?? "unknown");
    const key = modelKey(provider, model);
    const modelBucket = seriesByModel.get(key) ?? [];
    modelBucket.push(point);
    seriesByModel.set(key, modelBucket);
    const providerBucket = seriesByProvider.get(provider) ?? [];
    providerBucket.push(point);
    seriesByProvider.set(provider, providerBucket);
  }

  const providers = new Map();
  for (const [provider, rows] of byProvider) {
    const totalRequests = rows.reduce((sum, row) => sum + row.totalRequests, 0);
    const sortedByRequests = [...rows].sort((a, b) => b.totalRequests - a.totalRequests);
    const dominant = sortedByRequests[0];
    const cacheAggregate = providerCache.get(provider);
    const cacheSupported = rows.some(cacheEvidence);
    const meaningfulCacheRows = rows
      .filter(row => row.totalRequests >= CACHE_MIN_REQUESTS)
      .filter(row => Number(row.totalInputTokens || 0) + Number(row.totalCacheReadTokens || 0) >= CACHE_MIN_TOKENS)
      .filter(row => cacheEvidence(row) || cacheSupported)
      .map(row => ({ ...row, resolvedCacheRate: rowCacheRate(row) }))
      .sort((a, b) => a.resolvedCacheRate - b.resolvedCacheRate);

    providers.set(provider, {
      provider,
      rows,
      totalRequests,
      dominantModel: dominant ? {
        ...dominant,
        requestShare: totalRequests > 0 ? dominant.totalRequests / totalRequests : 0,
        requestTrend: requestTrend(seriesByModel.get(modelKey(provider, dominant.model))),
      } : undefined,
      requestTrend: requestTrend(seriesByProvider.get(provider)),
      cacheSupported,
      cacheRate: cacheAggregate?.cacheRate,
      cacheReadTokens: Number(cacheAggregate?.totalCacheReadTokens || 0),
      cacheWriteTokens: Number(cacheAggregate?.totalCacheWriteTokens || 0),
      lowCacheModel: meaningfulCacheRows[0],
      highestUncachedModel: [...rows]
        .filter(row => row.totalRequests >= CACHE_MIN_REQUESTS)
        .sort((a, b) => Number(b.totalInputTokens || 0) - Number(a.totalInputTokens || 0))[0],
    });
  }

  return { models, providers };
}

function flattenQuota(quota) {
  const rows = [];
  for (const report of quota?.reports ?? []) {
    for (const group of quotaDisplayGroups(report)) {
      for (const limit of group.limits ?? []) {
        const intel = limit?.intelligence ?? {};
        const fraction = usedFraction(limit?.amount ?? {});
        const projectedExhaustAt = finite(intel.recentProjectedExhaustAt) ?? finite(intel.projectedExhaustAt);
        const etaHours = finite(intel.recentEtaHours) ?? finite(intel.etaHours);
        const paceRatio = finite(intel.recentPaceRatio) ?? finite(intel.paceRatio);
        const burnPerHour = finite(intel.recentBurnPerHour) ?? finite(intel.burnPerHour);
        rows.push({
          report,
          provider: String(report?.provider ?? limit?.scope?.provider ?? "unknown"),
          limit,
          label: String(limit?.label ?? limit?.window?.label ?? limit?.id ?? "quota"),
          groupLabel: group.label || "",
          usedFraction: fraction,
          status: String(intel.status ?? limit?.status ?? "unknown"),
          resetsAt: finite(limit?.window?.resetsAt) ?? finite(intel.resetsAt),
          projectedExhaustAt,
          etaHours,
          paceRatio,
          burnPerHour,
          baselineBurnPerHour: finite(intel.baselineBurnPerHour),
          accelerationRatio: finite(intel.accelerationRatio),
          burnTrend: String(intel.burnTrend ?? "unknown"),
          modelId: typeof limit?.scope?.modelId === "string" ? limit.scope.modelId : undefined,
        });
      }
    }
  }
  return rows;
}

function quotaUrgency(row, now) {
  if (row.status === "exhausted" || Number(row.usedFraction) >= 1) return 100;
  if (row.status === "at-risk") {
    const eta = row.etaHours;
    if (Number.isFinite(eta) && eta <= 6) return 95;
    if (Number.isFinite(eta) && eta <= 24) return 90;
    if (Number.isFinite(eta) && eta <= 72) return 82;
    return 75;
  }
  if (Number.isFinite(row.paceRatio) && row.paceRatio >= 2) return 72;
  if (Number.isFinite(row.accelerationRatio) && row.accelerationRatio >= 2) return 68;
  if (Number.isFinite(row.usedFraction) && row.usedFraction >= 0.9) return 65;
  if (row.status === "watch" || (Number.isFinite(row.paceRatio) && row.paceRatio >= 0.8)) return 55;
  if (Number.isFinite(row.resetsAt) && row.resetsAt <= now) return 40;
  return Math.round((row.usedFraction ?? 0) * 40);
}

function providerQuotaSummaries(quotaRows, facts, now) {
  const grouped = new Map();
  for (const row of quotaRows) {
    const bucket = grouped.get(row.provider) ?? [];
    bucket.push(row);
    grouped.set(row.provider, bucket);
  }

  const summaries = [];
  for (const [provider, rows] of grouped) {
    const sorted = [...rows].sort((a, b) => quotaUrgency(b, now) - quotaUrgency(a, now));
    const worst = sorted[0];
    const resets = rows.map(row => row.resetsAt).filter(value => Number.isFinite(value) && value > now);
    const earliestProviderResetAt = resets.length ? Math.min(...resets) : undefined;
    const model = facts.providers.get(provider);
    let attribution;
    if (worst?.modelId) {
      attribution = { type: "direct", model: worst.modelId, share: undefined };
    } else if (model?.dominantModel && model.dominantModel.totalRequests >= CACHE_MIN_REQUESTS && model.dominantModel.requestShare >= 0.4) {
      attribution = {
        type: "dominant-workload",
        model: model.dominantModel.model,
        share: model.dominantModel.requestShare,
      };
    }

    const reports = [...new Set(rows.map(row => row.report).filter(Boolean))];
    const resetCreditsAvailable = reports.reduce((sum, report) => {
      const count = finite(report?.resetCredits?.availableCount);
      return sum + (count && count > 0 ? count : 0);
    }, 0);
    summaries.push({
      provider,
      worst,
      resetAt: worst?.resetsAt,
      earliestProviderResetAt,
      attribution,
      modelFacts: model,
      exhaustedCount: rows.filter(row => row.status === "exhausted" || Number(row.usedFraction) >= 1).length,
      atRiskCount: rows.filter(row => row.status === "at-risk").length,
      watchCount: rows.filter(row => row.status === "watch").length,
      resetCreditsAvailable,
      urgency: worst ? quotaUrgency(worst, now) : 0,
    });
  }
  return summaries.sort((a, b) => b.urgency - a.urgency);
}

function failedRequests(row) {
  if (Number.isFinite(row.failedRequests)) return row.failedRequests;
  if (Number.isFinite(row.errorRate)) return Math.round(row.totalRequests * row.errorRate);
  return 0;
}

function reliabilitySummary(models) {
  const failures = [];
  for (const row of models) {
    const failed = failedRequests(row);
    const errorRate = Number(row.errorRate || 0);
    if (!failed || !errorRate) continue;
    const confidence = confidenceForRequests(row.totalRequests);
    let severity;
    if (row.totalRequests >= 20 && errorRate >= 0.5 && failed >= 10) severity = "critical";
    else if (row.totalRequests >= 5 && errorRate >= 0.2) severity = "warning";
    else if (row.totalRequests >= 2 && errorRate >= 1) severity = "warning";
    else if (failed >= 3 && errorRate >= 0.05) severity = "watch";
    else continue;
    failures.push({
      provider: row.provider,
      model: row.model,
      totalRequests: row.totalRequests,
      failedRequests: failed,
      errorRate,
      confidence,
      severity,
      score: SEVERITY[severity] * 100 + Math.min(50, failed),
    });
  }
  failures.sort((a, b) => b.score - a.score);

  const meaningful = models.filter(row => row.totalRequests >= 5);
  const ttfts = meaningful.map(row => row.avgTtft).filter(Number.isFinite).sort((a, b) => a - b);
  const tpsValues = meaningful.map(row => row.avgTokensPerSecond).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const median = values => {
    if (!values.length) return undefined;
    const m = Math.floor(values.length / 2);
    return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
  };
  const medianTtft = median(ttfts);
  const medianTps = median(tpsValues);

  const performanceOutliers = [];
  for (const row of meaningful) {
    if (Number.isFinite(medianTtft) && Number.isFinite(row.avgTtft) && row.avgTtft >= Math.max(5_000, medianTtft * 2)) {
      performanceOutliers.push({ kind: "slow-ttft", row, ratio: row.avgTtft / medianTtft });
    }
    if (Number.isFinite(medianTps) && medianTps > 0 && Number.isFinite(row.avgTokensPerSecond) && row.avgTokensPerSecond > 0 && row.avgTokensPerSecond <= medianTps * 0.4) {
      performanceOutliers.push({ kind: "low-tps", row, ratio: row.avgTokensPerSecond / medianTps });
    }
  }

  return {
    activeModels: models.filter(row => row.totalRequests > 0).length,
    failures,
    unhealthyModels: new Set(failures.map(row => modelKey(row.provider, row.model))).size,
    performanceOutliers,
  };
}

function weightedCacheRate(rows) {
  let uncached = 0;
  let cached = 0;
  for (const row of rows ?? []) {
    uncached += Number(row?.uncachedInputTokens || row?.totalInputTokens || 0);
    cached += Number(row?.cacheReadTokens || row?.totalCacheReadTokens || 0);
  }
  const total = uncached + cached;
  return total > 0 ? cached / total : undefined;
}

function medianNumber(values) {
  const sorted = (values ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cacheDiagnosis(cacheDiagnostics, target) {
  if (!cacheDiagnostics || !target) return undefined;
  const match = row => row.provider === target.provider && row.model === target.model;
  const agents = (cacheDiagnostics.byAgentModel ?? []).filter(match)
    .sort((a, b) => b.uncachedInputTokens - a.uncachedInputTokens);
  const folders = (cacheDiagnostics.byFolderModel ?? []).filter(match)
    .sort((a, b) => b.uncachedInputTokens - a.uncachedInputTokens);
  const sessions = (cacheDiagnostics.bySessionModel ?? []).filter(match)
    .sort((a, b) => b.uncachedInputTokens - a.uncachedInputTokens);
  const total = Math.max(1, target.uncachedInputTokens || 0);
  const topAgent = agents[0] ? { ...agents[0], share: agents[0].uncachedInputTokens / total } : undefined;
  const topFolder = folders[0] ? { ...folders[0], share: folders[0].uncachedInputTokens / total } : undefined;
  const topSession = sessions[0] ? { ...sessions[0], share: sessions[0].uncachedInputTokens / total } : undefined;

  const peers = (cacheDiagnostics.byModel ?? [])
    .filter(row => row.provider === target.provider && row.model !== target.model)
    .filter(row => row.requests >= CACHE_MIN_REQUESTS);
  const peerInputPerRequest = medianNumber(peers.map(row => row.requests > 0 ? row.uncachedInputTokens / row.requests : undefined));
  const inputPerRequest = target.requests > 0 ? target.uncachedInputTokens / target.requests : undefined;
  const largePromptRatio = Number.isFinite(peerInputPerRequest) && peerInputPerRequest > 0 && Number.isFinite(inputPerRequest)
    ? inputPerRequest / peerInputPerRequest
    : undefined;

  const likely = [];
  if (topAgent && topAgent.agentType !== "main" && topAgent.share >= 0.5) {
    likely.push({ kind: "agent-concentration", agentType: topAgent.agentType, share: topAgent.share });
  }
  if (topFolder && topFolder.share >= 0.5) {
    likely.push({ kind: "project-concentration", folder: topFolder.folder, share: topFolder.share });
  }
  if (topSession && topSession.share >= 0.3) {
    likely.push({ kind: "session-concentration", sessionFile: topSession.sessionFile, folder: topSession.folder, share: topSession.share });
  }
  if (Number.isFinite(largePromptRatio) && largePromptRatio >= 2) {
    likely.push({ kind: "large-uncached-request", ratio: largePromptRatio, inputPerRequest, peerInputPerRequest });
  }

  return { agents, folders, sessions, topAgent, topFolder, topSession, inputPerRequest, peerInputPerRequest, largePromptRatio, likely };
}

function cacheSummary(stats, facts, cacheDiagnostics) {
  const overall = clamp01(Number(stats?.overall?.cacheRate || 0));
  const fallbackCandidates = [];
  for (const provider of facts.providers.values()) {
    const row = provider.lowCacheModel;
    if (!row) continue;
    const rate = row.resolvedCacheRate;
    const providerRate = Number.isFinite(provider.cacheRate) ? provider.cacheRate : overall;
    const peerGap = Math.max(overall - rate, providerRate - rate);
    let severity;
    if (rate < 0.3 && peerGap >= 0.15 && row.totalRequests >= 10) severity = "warning";
    else if (rate < 0.5 && peerGap >= 0.2) severity = "watch";
    else continue;
    fallbackCandidates.push({
      provider: row.provider,
      model: row.model,
      cacheRate: rate,
      providerCacheRate: providerRate,
      overallCacheRate: overall,
      gap: peerGap,
      totalRequests: row.totalRequests,
      totalInputTokens: row.totalInputTokens,
      severity,
      score: SEVERITY[severity] * 100 + Math.round(peerGap * 100),
    });
  }
  fallbackCandidates.sort((a, b) => b.score - a.score);

  const providerRows = [...facts.providers.values()]
    .filter(row => row.cacheSupported && Number.isFinite(row.cacheRate))
    .sort((a, b) => a.cacheRate - b.cacheRate);

  const diagModels = cacheDiagnostics?.byModel ?? [];
  const totalUncached = Number(cacheDiagnostics?.overall?.uncachedInputTokens || 0);
  const impactModels = [];
  for (const row of diagModels) {
    if (row.requests < 10 || row.uncachedInputTokens < 500_000) continue;
    const evidence = row.cacheReadTokens + row.cacheWriteTokens > 0;
    if (!evidence) continue;

    const siblings = diagModels
      .filter(peer => peer.provider === row.provider && peer.model !== row.model)
      .filter(peer => peer.requests >= CACHE_MIN_REQUESTS)
      .filter(peer => peer.cacheReadTokens + peer.cacheWriteTokens > 0)
      .sort((a, b) => b.requests - a.requests);
    const siblingRate = weightedCacheRate(siblings);
    const peerRates = diagModels
      .filter(peer => peer.provider !== row.provider || peer.model !== row.model)
      .filter(peer => peer.requests >= CACHE_MIN_REQUESTS)
      .filter(peer => peer.cacheReadTokens + peer.cacheWriteTokens > 0)
      .map(peer => peer.cacheRate);
    const peerMedian = medianNumber(peerRates);
    const comparisonRate = Number.isFinite(siblingRate) ? siblingRate : peerMedian;
    const gap = Number.isFinite(comparisonRate) ? comparisonRate - row.cacheRate : undefined;
    const share = totalUncached > 0 ? row.uncachedInputTokens / totalUncached : row.uncachedShare ?? 0;

    let severity;
    if ((share >= 0.5 && row.uncachedInputTokens >= 5_000_000 && row.cacheRate < 0.75)
      || (row.uncachedInputTokens >= 20_000_000 && row.cacheRate < 0.65)) {
      severity = "warning";
    } else if ((share >= 0.25 && row.uncachedInputTokens >= 2_000_000 && row.cacheRate < 0.8)
      || (Number.isFinite(gap) && gap >= 0.2 && row.uncachedInputTokens >= 1_000_000)) {
      severity = "watch";
    } else {
      continue;
    }

    const diagnosis = cacheDiagnosis(cacheDiagnostics, row);
    impactModels.push({
      ...row,
      uncachedShare: share,
      siblingCacheRate: siblingRate,
      peerMedianCacheRate: peerMedian,
      comparisonRate,
      comparisonKind: siblings.length === 1 ? "model" : siblings.length > 1 ? "siblings" : "peer-median",
      comparisonModel: siblings.length === 1 ? siblings[0].model : undefined,
      comparisonCount: siblings.length > 1 ? siblings.length : undefined,
      gap,
      severity,
      diagnosis,
      score: SEVERITY[severity] * 100
        + Math.min(70, Math.round(share * 70))
        + Math.min(40, Math.round(row.uncachedInputTokens / 1_000_000)),
    });
  }
  impactModels.sort((a, b) => b.score - a.score);

  const highestUncached = diagModels[0] ?? [...facts.models]
    .filter(row => row.totalRequests >= CACHE_MIN_REQUESTS)
    .sort((a, b) => Number(b.totalInputTokens || 0) - Number(a.totalInputTokens || 0))[0];

  return {
    overallCacheRate: cacheDiagnostics?.overall?.cacheRate ?? overall,
    totalUncachedInputTokens: totalUncached || Number(stats?.overall?.totalInputTokens || 0),
    impactModels,
    lowModels: fallbackCandidates,
    lowestProvider: providerRows[0],
    highestUncachedModel: highestUncached,
    diagnosticsAvailable: Boolean(cacheDiagnostics),
  };
}
function agentSummary(stats) {
  const rows = (stats?.byAgentType ?? []).map(row => ({ ...row, tokens: tokenTotal(row) }));
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const shares = rows
    .map(row => ({ ...row, share: total > 0 ? row.tokens / total : 0 }))
    .sort((a, b) => b.share - a.share);
  const alerts = [];
  for (const row of shares) {
    if (total < 10_000) continue;
    if (row.agentType === "advisor" && row.share >= 0.25) {
      alerts.push({ severity: row.share >= 0.4 ? "warning" : "watch", row });
    } else if (row.agentType === "subagent" && row.share >= 0.7) {
      alerts.push({ severity: "watch", row });
    }
  }
  return { totalTokens: total, shares, alerts };
}

function eventSummary(events, now) {
  const recentCutoff = now - HOUR_MS;
  const recent = (events ?? []).filter(event => Number(event?.at || 0) >= recentCutoff);
  const errors = recent.filter(event => event.level === "error");
  const warnings = recent.filter(event => event.level === "warn");
  const notable = [...recent].reverse().find(event => event.level === "error" || event.level === "warn");
  return { errors: errors.length, warnings: warnings.length, notable };
}

function pushAlert(alerts, alert) {
  const confidenceScore = alert.confidence === "high" ? 20 : alert.confidence === "medium" ? 10 : 0;
  alerts.push({ ...alert, score: SEVERITY[alert.severity] * 100 + (alert.urgency ?? 0) + confidenceScore });
}

export function buildOverviewIntelligence({ stats, quota, cacheDiagnostics, events = [], now = Date.now() } = {}) {
  const facts = modelFacts(stats ?? {});
  const quotaRows = flattenQuota(quota);
  const capacity = providerQuotaSummaries(quotaRows, facts, now);
  const reliability = reliabilitySummary(facts.models);
  const cache = cacheSummary(stats ?? {}, facts, cacheDiagnostics);
  const agents = agentSummary(stats ?? {});
  const activity = eventSummary(events, now);
  const systemRequestTrend = requestTrend(stats?.timeSeries);
  const alerts = [];

  for (const summary of capacity) {
    const row = summary.worst;
    if (!row) continue;
    const cacheRateValue = summary.modelFacts?.cacheRate;
    const cacheLow = summary.modelFacts?.cacheSupported && Number.isFinite(cacheRateValue) && cacheRateValue < 0.5;
    const requestTrendRatio = summary.modelFacts?.requestTrend?.ratio;
    const workloadElevated = Number.isFinite(requestTrendRatio) && requestTrendRatio >= 1.5;
    const burnAccelerated = Number.isFinite(row.accelerationRatio) && row.accelerationRatio >= 1.5;
    const correlation = {
      cacheLow,
      cacheRate: cacheRateValue,
      workloadElevated,
      requestTrendRatio,
    };

    const resetDue = Number.isFinite(row.resetsAt) && row.resetsAt <= now;
    const runwayMarginHours = Number.isFinite(row.resetsAt) && Number.isFinite(row.projectedExhaustAt)
      ? (row.resetsAt - row.projectedExhaustAt) / HOUR_MS
      : undefined;

    if ((row.status === "exhausted" || Number(row.usedFraction) >= 1) && resetDue) {
      pushAlert(alerts, {
        kind: "quota-reset-due",
        domain: "quota",
        severity: "warning",
        urgency: 35,
        confidence: "high",
        viewKey: "2",
        provider: summary.provider,
        quota: row,
        attribution: summary.attribution,
        correlation,
      });
      continue;
    }

    if (row.status === "exhausted" || Number(row.usedFraction) >= 1) {
      pushAlert(alerts, {
        kind: "quota-exhausted",
        domain: "quota",
        severity: "critical",
        urgency: 40,
        confidence: "high",
        actionLevel: "shift",
        viewKey: "2",
        provider: summary.provider,
        quota: row,
        attribution: summary.attribution,
        correlation,
      });
      continue;
    }

    if (row.status === "at-risk") {
      const eta = row.etaHours;
      let severity = "warning";
      let actionLevel = "reduce";
      if ((Number.isFinite(eta) && eta <= 6) || (Number.isFinite(runwayMarginHours) && runwayMarginHours >= 24)) {
        severity = "critical";
        actionLevel = "shift";
      } else if (Number.isFinite(runwayMarginHours) && runwayMarginHours < 6) {
        severity = "watch";
        actionLevel = "watch";
      }
      pushAlert(alerts, {
        kind: "quota-runway",
        domain: "quota",
        severity,
        urgency: Number.isFinite(eta) ? Math.max(0, 40 - Math.min(40, eta)) : 10,
        confidence: Number.isFinite(eta) ? "high" : "medium",
        actionLevel,
        runwayMarginHours,
        viewKey: "2",
        provider: summary.provider,
        quota: row,
        attribution: summary.attribution,
        correlation,
      });
      continue;
    }

    if (burnAccelerated && (Number.isFinite(row.paceRatio) ? row.paceRatio >= 1 : true)) {
      pushAlert(alerts, {
        kind: "quota-acceleration",
        domain: "quota",
        severity: row.burnTrend === "spike" ? "warning" : "watch",
        urgency: Number.isFinite(row.accelerationRatio) ? Math.min(30, Math.round(row.accelerationRatio * 10)) : 5,
        confidence: Number.isFinite(row.baselineBurnPerHour) ? "high" : "medium",
        actionLevel: Number.isFinite(row.accelerationRatio) && row.accelerationRatio >= 2 ? "reduce" : "watch",
        viewKey: "2",
        provider: summary.provider,
        quota: row,
        attribution: summary.attribution,
        correlation,
      });
    }
  }

  for (const failure of reliability.failures.slice(0, 3)) {
    pushAlert(alerts, {
      kind: "model-failure",
      domain: "models",
      severity: failure.severity,
      urgency: Math.min(30, failure.failedRequests),
      confidence: failure.confidence,
      viewKey: "3",
      ...failure,
    });
  }

  for (const impact of cache.impactModels.slice(0, 2)) {
    pushAlert(alerts, {
      kind: "cache-impact",
      domain: "cache",
      severity: impact.severity,
      urgency: Math.min(60, 20 + Math.round(impact.uncachedShare * 40)),
      confidence: confidenceForRequests(impact.requests),
      viewKey: "4",
      ...impact,
    });
  }

  if (!cache.impactModels.length) {
    for (const low of cache.lowModels.slice(0, 2)) {
      pushAlert(alerts, {
        kind: "cache-low",
        domain: "cache",
        severity: low.severity,
        urgency: Math.round(low.gap * 50),
        confidence: confidenceForRequests(low.totalRequests),
        viewKey: "4",
        ...low,
      });
    }
  }

  const perf = reliability.performanceOutliers[0];
  if (perf) {
    pushAlert(alerts, {
      kind: perf.kind,
      domain: "models",
      severity: "watch",
      urgency: Math.min(20, Math.round(Math.abs(perf.ratio - 1) * 10)),
      confidence: confidenceForRequests(perf.row.totalRequests),
      viewKey: "3",
      provider: perf.row.provider,
      model: perf.row.model,
      totalRequests: perf.row.totalRequests,
      ratio: perf.ratio,
      avgTtft: perf.row.avgTtft,
      avgTokensPerSecond: perf.row.avgTokensPerSecond,
    });
  }

  for (const item of agents.alerts.slice(0, 1)) {
    pushAlert(alerts, {
      kind: "agent-concentration",
      domain: "agents",
      severity: item.severity,
      urgency: Math.round(item.row.share * 20),
      confidence: "high",
      viewKey: "5",
      agentType: item.row.agentType,
      share: item.row.share,
      tokens: item.row.tokens,
    });
  }

  if (Number.isFinite(systemRequestTrend?.ratio) && systemRequestTrend.baselineSamples >= 2) {
    const ratio = systemRequestTrend.ratio;
    if (ratio >= 2.5) {
      pushAlert(alerts, {
        kind: "request-spike",
        domain: "system",
        severity: ratio >= 4 ? "warning" : "watch",
        urgency: Math.min(30, Math.round(ratio * 5)),
        confidence: systemRequestTrend.baselineSamples >= 4 ? "high" : "medium",
        viewKey: "3",
        ratio,
        recentPerHour: systemRequestTrend.recentPerHour,
        baselinePerHour: systemRequestTrend.baselinePerHour,
      });
    }
  }

  if (activity.errors > 0 && activity.notable) {
    pushAlert(alerts, {
      kind: "runtime-error",
      domain: "events",
      severity: "warning",
      urgency: Math.min(20, activity.errors * 5),
      confidence: "high",
      viewKey: "6",
      errors: activity.errors,
      warnings: activity.warnings,
      event: activity.notable,
    });
  }

  alerts.sort((a, b) => b.score - a.score || String(a.kind).localeCompare(String(b.kind)));

  return {
    coverage: {
      stats: Boolean(stats),
      quota: quotaRows.length > 0,
      agents: (stats?.byAgentType ?? []).length > 0,
      events: (events ?? []).length > 0,
    },
    alertCount: alerts.length,
    alerts: alerts.slice(0, 4),
    capacity,
    reliability,
    cache,
    agents,
    activity,
    requestTrend: systemRequestTrend,
    modelFacts: facts,
  };
}
