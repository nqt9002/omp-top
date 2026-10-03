import assert from "node:assert/strict";
import test from "node:test";
import { quotaIntelligenceForSeries } from "../src/intelligence.mjs";
import { buildOverviewIntelligence } from "../src/overview-intelligence.mjs";
import { normalizeStats } from "../src/stats.mjs";
import { renderView } from "../src/views.mjs";
import { getLocale, setLocale } from "../src/i18n.mjs";
import { stripAnsi } from "../src/format.mjs";

const HOUR = 60 * 60 * 1000;
const base = {
  provider: "openai-codex",
  accountKey: "acct",
  limitId: "weekly",
  label: "Weekly",
  windowLabel: "Weekly",
};

test("quota acceleration baseline is reset-aware and uses older cycles", () => {
  const now = 1_800_000_000_000;
  const oldReset = now - 5 * HOUR;
  const currentReset = now + 10 * HOUR;
  const rows = [
    { ...base, recordedAt: now - 12 * HOUR, usedFraction: 0.10, resetsAt: oldReset },
    { ...base, recordedAt: now - 11 * HOUR, usedFraction: 0.12, resetsAt: oldReset },
    { ...base, recordedAt: now - 10 * HOUR, usedFraction: 0.14, resetsAt: oldReset },
    { ...base, recordedAt: now - 9 * HOUR, usedFraction: 0.16, resetsAt: oldReset },
    { ...base, recordedAt: now - 8 * HOUR, usedFraction: 0.18, resetsAt: oldReset },
    { ...base, recordedAt: now - 3 * HOUR, usedFraction: 0.10, resetsAt: currentReset },
    { ...base, recordedAt: now - 2 * HOUR, usedFraction: 0.15, resetsAt: currentReset },
    { ...base, recordedAt: now - 1 * HOUR, usedFraction: 0.20, resetsAt: currentReset },
    { ...base, recordedAt: now, usedFraction: 0.25, resetsAt: currentReset },
  ];
  const intel = quotaIntelligenceForSeries(rows);
  assert.equal(intel.sampleCount, 4);
  assert.ok(Math.abs(intel.recentBurnPerHour - 0.05) < 1e-9);
  assert.ok(Math.abs(intel.baselineBurnPerHour - 0.02) < 1e-9);
  assert.ok(intel.accelerationRatio > 2.49 && intel.accelerationRatio < 2.51);
  assert.equal(intel.burnTrend, "spike");
});

function decisionFixture(now = Date.now()) {
  const stats = normalizeStats({
    overall: {
      totalRequests: 104,
      failedRequests: 2,
      errorRate: 2 / 104,
      cacheRate: 0.4,
      avgTtft: 4000,
      avgDuration: 9000,
      avgTokensPerSecond: 35,
      totalInputTokens: 90_000,
      totalOutputTokens: 10_000,
      totalCacheReadTokens: 35_000,
      totalCacheWriteTokens: 12_000,
      totalCost: 20,
    },
    byModel: [
      {
        provider: "openai-codex", model: "gpt-6-astra",
        totalRequests: 80, successfulRequests: 80, failedRequests: 0, errorRate: 0,
        totalInputTokens: 80_000, totalOutputTokens: 8_000,
        totalCacheReadTokens: 20_000, totalCacheWriteTokens: 10_000,
        cacheRate: 0.2, totalCost: 15, avgTtft: 3500, avgDuration: 8000, avgTokensPerSecond: 40,
      },
      {
        provider: "openai-codex", model: "gpt-6-sol",
        totalRequests: 20, successfulRequests: 20, failedRequests: 0, errorRate: 0,
        totalInputTokens: 5_000, totalOutputTokens: 1_500,
        totalCacheReadTokens: 15_000, totalCacheWriteTokens: 2_000,
        cacheRate: 0.75, totalCost: 4, avgTtft: 3000, avgDuration: 7000, avgTokensPerSecond: 45,
      },
      {
        provider: "anthropic", model: "claude-sonnet-5-5",
        totalRequests: 2, successfulRequests: 0, failedRequests: 2, errorRate: 1,
        totalInputTokens: 2_000, totalOutputTokens: 100,
        totalCacheReadTokens: 1_000, totalCacheWriteTokens: 100,
        cacheRate: 1 / 3, totalCost: 1, avgTtft: 100, avgDuration: 500, avgTokensPerSecond: 10,
      },
    ],
    modelSeries: [
      ...[-10,-9,-8,-7,-6,-5,-4].map(h => ({ timestamp: now + h * HOUR, provider: "openai-codex", model: "gpt-6-astra", requests: 2 })),
      ...[-2,-1,0].map(h => ({ timestamp: now + h * HOUR, provider: "openai-codex", model: "gpt-6-astra", requests: 10 })),
      ...[-10,-9,-8,-7,-6,-5,-4].map(h => ({ timestamp: now + h * HOUR, provider: "openai-codex", model: "gpt-6-sol", requests: 1 })),
      ...[-2,-1,0].map(h => ({ timestamp: now + h * HOUR, provider: "openai-codex", model: "gpt-6-sol", requests: 2 })),
    ],
    byAgentType: [
      { agentType: "main", totalRequests: 70, totalInputTokens: 40_000, totalOutputTokens: 5_000, totalCacheReadTokens: 20_000, totalCacheWriteTokens: 5_000, totalCost: 12 },
      { agentType: "advisor", totalRequests: 25, totalInputTokens: 30_000, totalOutputTokens: 3_000, totalCacheReadTokens: 5_000, totalCacheWriteTokens: 2_000, totalCost: 7 },
      { agentType: "subagent", totalRequests: 9, totalInputTokens: 4_000, totalOutputTokens: 500, totalCacheReadTokens: 500, totalCacheWriteTokens: 0, totalCost: 1 },
    ],
    timeSeries: [
      ...[-10,-9,-8,-7,-6,-5,-4].map(h => ({ timestamp: now + h * HOUR, requests: 3, errors: 0 })),
      ...[-2,-1,0].map(h => ({ timestamp: now + h * HOUR, requests: 12, errors: 0 })),
    ],
  });

  const quota = {
    generatedAt: now,
    reports: [{
      provider: "openai-codex",
      fetchedAt: now,
      metadata: { accountId: "codex" },
      limits: [{
        id: "weekly",
        label: "Weekly",
        scope: { provider: "openai-codex", windowId: "weekly" },
        window: { id: "weekly", label: "Weekly", resetsAt: now + 48 * HOUR },
        amount: { usedFraction: 0.80, unit: "percent" },
        intelligence: {
          status: "at-risk",
          usedFraction: 0.80,
          recentBurnPerHour: 0.05,
          baselineBurnPerHour: 0.02,
          accelerationRatio: 2.5,
          burnTrend: "spike",
          recentEtaHours: 4,
          recentProjectedExhaustAt: now + 4 * HOUR,
          sustainablePerHour: 0.0042,
          recentPaceRatio: 11.9,
          resetsAt: now + 48 * HOUR,
        },
      }],
    }],
  };

  const events = [
    { at: now - 10 * 60_000, level: "error", message: "quota refresh error: provider timeout" },
  ];
  return { stats, quota, events, now };
}

test("decision engine surfaces quota urgency, conservative workload attribution, cache correlation and failures", () => {
  const fixture = decisionFixture();
  const overview = buildOverviewIntelligence(fixture);
  const quotaAlert = overview.alerts.find(alert => alert.kind === "quota-runway");
  assert.ok(quotaAlert);
  assert.equal(quotaAlert.severity, "critical");
  assert.equal(quotaAlert.attribution.type, "dominant-workload");
  assert.equal(quotaAlert.attribution.model, "gpt-6-astra");
  assert.ok(quotaAlert.attribution.share > 0.79);
  assert.equal(quotaAlert.correlation.cacheLow, true);
  assert.equal(quotaAlert.correlation.workloadElevated, true);

  const failure = overview.alerts.find(alert => alert.kind === "model-failure");
  assert.ok(failure);
  assert.equal(failure.model, "claude-sonnet-5-5");
  assert.equal(failure.confidence, "low");
  assert.equal(failure.failedRequests, 2);

  const cache = overview.alerts.find(alert => alert.kind === "cache-low");
  assert.ok(cache);
  assert.equal(cache.model, "gpt-6-astra");

  assert.equal(overview.capacity[0].attribution.type, "dominant-workload");
  assert.ok(overview.requestTrend.ratio > 1.5);
});

test("direct model-scoped quota is labeled direct instead of inferred workload", () => {
  const now = Date.now();
  const overview = buildOverviewIntelligence({
    stats: normalizeStats({ byModel: [{ provider: "openai-codex", model: "gpt-6-astra", totalRequests: 100 }] }),
    quota: {
      reports: [{
        provider: "openai-codex",
        limits: [{
          id: "model",
          label: "Astra",
          scope: { provider: "openai-codex", modelId: "gpt-6-astra" },
          window: { resetsAt: now + HOUR },
          amount: { usedFraction: 0.95 },
          intelligence: { status: "at-risk", recentEtaHours: 0.5, recentProjectedExhaustAt: now + 0.5 * HOUR },
        }],
      }],
    },
    now,
  });
  assert.equal(overview.capacity[0].attribution.type, "direct");
  assert.equal(overview.capacity[0].attribution.model, "gpt-6-astra");
});

test("cache alerts require evidence that prompt caching is actually in use", () => {
  const stats = normalizeStats({
    overall: { cacheRate: 0 },
    byModel: [{
      provider: "example", model: "no-cache-model", totalRequests: 100,
      totalInputTokens: 50_000, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, cacheRate: 0,
    }],
  });
  const overview = buildOverviewIntelligence({ stats });
  assert.equal(overview.cache.lowModels.length, 0);
  assert.equal(overview.alerts.some(alert => alert.kind === "cache-low"), false);
});

test("Overview renders decision-support evidence in English and Vietnamese", () => {
  const fixture = decisionFixture();
  const previous = getLocale();
  try {
    setLocale("en");
    const english = stripAnsi(renderView("overview", fixture, 156).join("\n"));
    assert.match(english, /ATTENTION/);
    assert.match(english, /Codex quota may exhaust in 4h/);
    assert.match(english, /Dominant OpenAI Codex workload: gpt-6-astra/);
    assert.match(english, /may both be contributing/);
    assert.match(english, /claude-sonnet-5-5/);
    assert.doesNotMatch(english, /TOP MODELS/);

    setLocale("vi");
    const vietnamese = stripAnsi(renderView("overview", fixture, 156).join("\n"));
    assert.match(vietnamese, /CẦN CHÚ Ý/);
    assert.match(vietnamese, /Quota OpenAI Codex có thể cạn sau 4g/);
    assert.match(vietnamese, /Workload chính của OpenAI Codex: gpt-6-astra/);
    assert.match(vietnamese, /có thể cùng góp phần/);
    assert.match(vietnamese, /ĐỘ TIN CẬY MÔ HÌNH/);
  } finally {
    setLocale(previous);
  }
});
