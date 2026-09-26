import { describe, expect, test } from "bun:test";
import type { ModelStats } from "@oh-my-pi/omp-stats";
import { aggregateCacheByProvider, sortModelsForCache } from "../src/cache";

function model(provider: string, name: string, requests: number, input: number, cacheRead: number): ModelStats {
  return {
    provider,
    model: name,
    totalRequests: requests,
    successfulRequests: requests,
    failedRequests: 0,
    errorRate: 0,
    totalInputTokens: input,
    totalOutputTokens: 0,
    totalCacheReadTokens: cacheRead,
    totalCacheWriteTokens: 0,
    cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0,
    cacheSavings: 0,
    totalCost: 0,
    unpricedRequests: 0,
    totalPremiumRequests: 0,
    avgDuration: null,
    avgTtft: null,
    avgTokensPerSecond: null,
    firstTimestamp: 0,
    lastTimestamp: 0,
  };
}

describe("aggregateCacheByProvider", () => {
  test("uses token-weighted cache rate instead of averaging model percentages", () => {
    const rows = aggregateCacheByProvider([
      model("openai-codex", "large", 10, 900, 100),
      model("openai-codex", "small", 1, 0, 100),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cacheRate).toBeCloseTo(200 / 1100, 8);
    expect(rows[0]?.totalRequests).toBe(11);
    expect(rows[0]?.totalCacheReadTokens).toBe(200);
  });
});

describe("sortModelsForCache", () => {
  test("groups by provider and sorts busiest models first", () => {
    const rows = sortModelsForCache([
      model("openai-codex", "b", 2, 1, 1),
      model("anthropic", "c", 3, 1, 1),
      model("openai-codex", "a", 9, 1, 1),
    ]);
    expect(rows.map(row => `${row.provider}:${row.model}`)).toEqual([
      "anthropic:c",
      "openai-codex:a",
      "openai-codex:b",
    ]);
  });
});
