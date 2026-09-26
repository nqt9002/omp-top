export function normalizeStats(value) {
  const stats = value && typeof value === "object" ? value : {};
  return {
    overall: stats.overall && typeof stats.overall === "object" ? stats.overall : {},
    byModel: Array.isArray(stats.byModel) ? stats.byModel : [],
  };
}

export function cacheRate(input, cacheRead) {
  const denom = Number(input || 0) + Number(cacheRead || 0);
  return denom > 0 ? Number(cacheRead || 0) / denom : 0;
}

export function aggregateCacheByProvider(models) {
  const map = new Map();
  for (const model of models ?? []) {
    const provider = String(model.provider ?? "unknown");
    const row = map.get(provider) ?? {
      provider, totalRequests: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    };
    row.totalRequests += Number(model.totalRequests || 0);
    row.totalInputTokens += Number(model.totalInputTokens || 0);
    row.totalCacheReadTokens += Number(model.totalCacheReadTokens || 0);
    row.totalCacheWriteTokens += Number(model.totalCacheWriteTokens || 0);
    map.set(provider, row);
  }
  return [...map.values()].map(row => ({ ...row, cacheRate: cacheRate(row.totalInputTokens, row.totalCacheReadTokens) }))
    .sort((a, b) => b.totalRequests - a.totalRequests || a.provider.localeCompare(b.provider));
}

export function sortModels(models) {
  return [...(models ?? [])].sort((a, b) => String(a.provider ?? "").localeCompare(String(b.provider ?? "")) || Number(b.totalRequests || 0) - Number(a.totalRequests || 0) || String(a.model ?? "").localeCompare(String(b.model ?? "")));
}
