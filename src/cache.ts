import type { ModelStats } from "@oh-my-pi/omp-stats";

export interface ProviderCacheStats {
  provider: string;
  totalRequests: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  cacheRate: number;
}

/** Aggregate model rows into provider rows using token-weighted cache rate. */
export function aggregateCacheByProvider(models: readonly ModelStats[]): ProviderCacheStats[] {
  const grouped = new Map<string, ProviderCacheStats>();

  for (const model of models) {
    const current = grouped.get(model.provider) ?? {
      provider: model.provider,
      totalRequests: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      cacheRate: 0,
    };
    current.totalRequests += model.totalRequests;
    current.totalInputTokens += model.totalInputTokens;
    current.totalCacheReadTokens += model.totalCacheReadTokens;
    current.totalCacheWriteTokens += model.totalCacheWriteTokens;
    grouped.set(model.provider, current);
  }

  const rows = [...grouped.values()];
  for (const row of rows) {
    const promptTokens = row.totalInputTokens + row.totalCacheReadTokens;
    row.cacheRate = promptTokens > 0 ? row.totalCacheReadTokens / promptTokens : 0;
  }

  return rows.sort((a, b) => b.totalRequests - a.totalRequests || a.provider.localeCompare(b.provider));
}

export function sortModelsForCache(models: readonly ModelStats[]): ModelStats[] {
  return [...models].sort((a, b) => {
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) return providerCompare;
    return b.totalRequests - a.totalRequests || a.model.localeCompare(b.model);
  });
}
