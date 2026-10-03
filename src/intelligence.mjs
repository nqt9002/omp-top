const HOUR_MS = 60 * 60 * 1000;
const RESET_DROP = 0.02;
const RESET_TOLERANCE_MS = 60 * 1000;
const RECENT_BURN_WINDOW_MS = 4 * HOUR_MS;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

function median(values) {
  const sorted = (values ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function quotaSeriesKey(row) {
  return `${String(row?.provider ?? "unknown")}\0${String(row?.accountKey ?? "")}\0${String(row?.limitId ?? "")}`;
}

function dedupeSamples(rows) {
  const byTimestamp = new Map();
  for (const row of rows) {
    const recordedAt = finiteNumber(row?.recordedAt);
    const usedFraction = finiteNumber(row?.usedFraction);
    if (recordedAt === undefined || usedFraction === undefined) continue;
    byTimestamp.set(recordedAt, { ...row, recordedAt, usedFraction: clamp01(usedFraction) });
  }
  return [...byTimestamp.values()].sort((a, b) => a.recordedAt - b.recordedAt);
}

function sameResetCycle(a, b) {
  const left = finiteNumber(a?.resetsAt);
  const right = finiteNumber(b?.resetsAt);
  if (left === undefined || right === undefined) return true;
  return Math.abs(left - right) <= RESET_TOLERANCE_MS;
}

function currentCycle(samples) {
  if (samples.length < 2) return samples;
  const latest = samples.at(-1);
  const latestReset = finiteNumber(latest?.resetsAt);
  if (latestReset !== undefined) {
    const sameReset = samples.filter(sample => {
      const reset = finiteNumber(sample?.resetsAt);
      return reset !== undefined && Math.abs(reset - latestReset) <= RESET_TOLERANCE_MS;
    });
    if (sameReset.length >= 2) return sameReset;
  }

  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].usedFraction + RESET_DROP < samples[i - 1].usedFraction) start = i;
  }
  return samples.slice(start);
}

function intervalBurnRates(samples) {
  const rates = [];
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    const elapsedHours = (current.recordedAt - previous.recordedAt) / HOUR_MS;
    if (!Number.isFinite(elapsedHours) || elapsedHours < 1 / 60) continue;
    if (!sameResetCycle(previous, current)) continue;
    const delta = current.usedFraction - previous.usedFraction;
    if (delta < -RESET_DROP) continue;
    rates.push({
      rate: Math.max(0, delta) / elapsedHours,
      startAt: previous.recordedAt,
      endAt: current.recordedAt,
    });
  }
  return rates;
}

export function quotaIntelligenceForSeries(rows) {
  const allSamples = dedupeSamples(rows);
  const samples = currentCycle(allSamples);
  if (!samples.length) return undefined;
  const latest = samples.at(-1);
  const usedFraction = clamp01(latest.usedFraction);
  const resetsAt = finiteNumber(latest.resetsAt);
  const result = {
    sampleCount: samples.length,
    historySampleCount: allSamples.length,
    observedHours: 0,
    usedFraction,
    remainingFraction: Math.max(0, 1 - usedFraction),
    resetsAt,
    burnPerHour: undefined,
    recentBurnPerHour: undefined,
    baselineBurnPerHour: undefined,
    accelerationRatio: undefined,
    burnTrend: "unknown",
    etaHours: undefined,
    recentEtaHours: undefined,
    projectedExhaustAt: undefined,
    recentProjectedExhaustAt: undefined,
    sustainablePerHour: undefined,
    paceRatio: undefined,
    recentPaceRatio: undefined,
    status: usedFraction >= 1 ? "exhausted" : "unknown",
  };

  if (samples.length >= 2) {
    const first = samples[0];
    const elapsedHours = (latest.recordedAt - first.recordedAt) / HOUR_MS;
    result.observedHours = Math.max(0, elapsedHours);
    if (elapsedHours >= 1 / 60) {
      result.burnPerHour = Math.max(0, (usedFraction - first.usedFraction) / elapsedHours);
    }
  }

  const currentRates = intervalBurnRates(samples);
  const recentCutoff = latest.recordedAt - RECENT_BURN_WINDOW_MS;
  const recentRates = currentRates.filter(point => point.endAt >= recentCutoff);
  if (recentRates.length >= 1) result.recentBurnPerHour = median(recentRates.map(point => point.rate));

  const historicalRates = intervalBurnRates(allSamples).filter(point => point.endAt < recentCutoff);
  if (historicalRates.length >= 4) result.baselineBurnPerHour = median(historicalRates.map(point => point.rate));

  if (Number.isFinite(result.recentBurnPerHour) && Number.isFinite(result.baselineBurnPerHour)) {
    if (result.baselineBurnPerHour > 1e-6) {
      result.accelerationRatio = result.recentBurnPerHour / result.baselineBurnPerHour;
      if (result.accelerationRatio >= 2) result.burnTrend = "spike";
      else if (result.accelerationRatio >= 1.5) result.burnTrend = "elevated";
      else if (result.accelerationRatio <= 0.75) result.burnTrend = "slower";
      else result.burnTrend = "normal";
    } else if (result.recentBurnPerHour > 1e-4) {
      result.burnTrend = "elevated";
    } else {
      result.burnTrend = "normal";
    }
  }

  const remaining = result.remainingFraction;
  if (Number.isFinite(result.burnPerHour) && result.burnPerHour > 1e-9) {
    result.etaHours = remaining / result.burnPerHour;
    result.projectedExhaustAt = latest.recordedAt + result.etaHours * HOUR_MS;
  }
  if (Number.isFinite(result.recentBurnPerHour) && result.recentBurnPerHour > 1e-9) {
    result.recentEtaHours = remaining / result.recentBurnPerHour;
    result.recentProjectedExhaustAt = latest.recordedAt + result.recentEtaHours * HOUR_MS;
  }

  if (resetsAt !== undefined && resetsAt > latest.recordedAt) {
    const resetHours = (resetsAt - latest.recordedAt) / HOUR_MS;
    result.sustainablePerHour = resetHours > 0 ? remaining / resetHours : undefined;
    if (result.sustainablePerHour > 1e-9 && Number.isFinite(result.burnPerHour)) {
      result.paceRatio = result.burnPerHour / result.sustainablePerHour;
    }
    if (result.sustainablePerHour > 1e-9 && Number.isFinite(result.recentBurnPerHour)) {
      result.recentPaceRatio = result.recentBurnPerHour / result.sustainablePerHour;
    }
  }

  const forecastExhaustAt = result.recentProjectedExhaustAt ?? result.projectedExhaustAt;
  const forecastPace = result.recentPaceRatio ?? result.paceRatio;
  if (usedFraction >= 1) result.status = "exhausted";
  else if (forecastExhaustAt !== undefined && resetsAt !== undefined && forecastExhaustAt < resetsAt) result.status = "at-risk";
  else if (Number.isFinite(forecastPace) && forecastPace >= 0.8) result.status = "watch";
  else if (result.burnPerHour !== undefined || result.recentBurnPerHour !== undefined) result.status = "ok";
  return result;
}

export function quotaIntelligenceBySeries(rows) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const key = quotaSeriesKey(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const result = new Map();
  for (const [key, bucket] of groups) {
    const intelligence = quotaIntelligenceForSeries(bucket);
    if (intelligence) result.set(key, intelligence);
  }
  return result;
}

export function modelPerformanceRows(stats) {
  return [...(stats?.byModel ?? [])]
    .map(row => ({
      ...row,
      provider: String(row?.provider ?? "unknown"),
      model: String(row?.model ?? "unknown"),
      totalRequests: Number(row?.totalRequests || 0),
      successfulRequests: Number(row?.successfulRequests || 0),
      failedRequests: Number.isFinite(Number(row?.failedRequests)) ? Number(row.failedRequests) : undefined,
      errorRate: Number.isFinite(Number(row?.errorRate)) ? Number(row.errorRate) : undefined,
      cacheRate: Number.isFinite(Number(row?.cacheRate)) ? Number(row.cacheRate) : undefined,
      totalInputTokens: Number(row?.totalInputTokens || 0),
      totalOutputTokens: Number(row?.totalOutputTokens || 0),
      totalCacheReadTokens: Number(row?.totalCacheReadTokens || 0),
      totalCacheWriteTokens: Number(row?.totalCacheWriteTokens || 0),
      avgTtft: Number.isFinite(Number(row?.avgTtft)) ? Number(row.avgTtft) : undefined,
      avgDuration: Number.isFinite(Number(row?.avgDuration)) ? Number(row.avgDuration) : undefined,
      avgTokensPerSecond: Number.isFinite(Number(row?.avgTokensPerSecond)) ? Number(row.avgTokensPerSecond) : undefined,
      totalCost: Number.isFinite(Number(row?.totalCost)) ? Number(row.totalCost) : undefined,
    }))
    .sort((a, b) => b.totalRequests - a.totalRequests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
