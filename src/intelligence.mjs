const HOUR_MS = 60 * 60 * 1000;
const RESET_DROP = 0.02;
const RESET_TOLERANCE_MS = 60 * 1000;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

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

export function quotaIntelligenceForSeries(rows) {
  const samples = currentCycle(dedupeSamples(rows));
  if (!samples.length) return undefined;
  const latest = samples.at(-1);
  const usedFraction = clamp01(latest.usedFraction);
  const resetsAt = finiteNumber(latest.resetsAt);
  const result = {
    sampleCount: samples.length,
    observedHours: 0,
    usedFraction,
    resetsAt,
    burnPerHour: undefined,
    etaHours: undefined,
    projectedExhaustAt: undefined,
    sustainablePerHour: undefined,
    paceRatio: undefined,
    status: usedFraction >= 1 ? "exhausted" : "unknown",
  };

  if (samples.length >= 2) {
    const first = samples[0];
    const elapsedHours = (latest.recordedAt - first.recordedAt) / HOUR_MS;
    result.observedHours = Math.max(0, elapsedHours);
    if (elapsedHours >= 1 / 60) {
      result.burnPerHour = Math.max(0, (usedFraction - first.usedFraction) / elapsedHours);
      const remaining = Math.max(0, 1 - usedFraction);
      if (result.burnPerHour > 1e-9) {
        result.etaHours = remaining / result.burnPerHour;
        result.projectedExhaustAt = latest.recordedAt + result.etaHours * HOUR_MS;
      }
      if (resetsAt !== undefined && resetsAt > latest.recordedAt) {
        const resetHours = (resetsAt - latest.recordedAt) / HOUR_MS;
        result.sustainablePerHour = resetHours > 0 ? remaining / resetHours : undefined;
        if (result.sustainablePerHour > 1e-9) result.paceRatio = result.burnPerHour / result.sustainablePerHour;
      }
    }
  }

  if (usedFraction >= 1) result.status = "exhausted";
  else if (result.projectedExhaustAt !== undefined && resetsAt !== undefined && result.projectedExhaustAt < resetsAt) result.status = "at-risk";
  else if (Number.isFinite(result.paceRatio) && result.paceRatio >= 0.8) result.status = "watch";
  else if (result.burnPerHour !== undefined) result.status = "ok";
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
      errorRate: Number.isFinite(Number(row?.errorRate)) ? Number(row.errorRate) : undefined,
      avgTtft: Number.isFinite(Number(row?.avgTtft)) ? Number(row.avgTtft) : undefined,
      avgDuration: Number.isFinite(Number(row?.avgDuration)) ? Number(row.avgDuration) : undefined,
      avgTokensPerSecond: Number.isFinite(Number(row?.avgTokensPerSecond)) ? Number(row.avgTokensPerSecond) : undefined,
      totalCost: Number.isFinite(Number(row?.totalCost)) ? Number(row.totalCost) : undefined,
    }))
    .sort((a, b) => b.totalRequests - a.totalRequests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
