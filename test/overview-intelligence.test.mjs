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

  const failure = overview.reliability.failures.find(row => row.model === "claude-sonnet-5-5");
  assert.ok(failure);
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
    assert.match(english, /OpenAI Codex quota 80%/);
    assert.match(english, /→ shift work · 2 Quota/);
    assert.doesNotMatch(english, /workload attribution/);
    assert.match(english, /claude-sonnet-5-5/);
    assert.doesNotMatch(english, /TOP MODELS/);

    setLocale("vi");
    const vietnamese = stripAnsi(renderView("overview", fixture, 156).join("\n"));
    assert.match(vietnamese, /CẦN CHÚ Ý/);
    assert.match(vietnamese, /OpenAI Codex quota 80%/);
    assert.match(vietnamese, /→ chuyển tải · 2 Quota/);
    assert.doesNotMatch(vietnamese, /đây chỉ là tín hiệu workload/);
    assert.match(vietnamese, /TÌNH TRẠNG MODEL/);
  } finally {
    setLocale(previous);
  }
});


test("capacity summary preserves risk counts and saved reset credits", () => {
  const now = Date.now();
  const overview = buildOverviewIntelligence({
    stats: normalizeStats({ byModel: [] }),
    quota: {
      reports: [{
        provider: "openai-codex",
        resetCredits: { availableCount: 2 },
        limits: [
          {
            id: "primary",
            label: "5 Hour",
            scope: { provider: "openai-codex" },
            window: { resetsAt: now + 2 * HOUR },
            amount: { usedFraction: 1 },
            intelligence: { status: "exhausted", resetsAt: now + 2 * HOUR },
          },
          {
            id: "secondary",
            label: "Weekly",
            scope: { provider: "openai-codex" },
            window: { resetsAt: now + 2 * 24 * HOUR },
            amount: { usedFraction: 0.85 },
            intelligence: { status: "at-risk", recentEtaHours: 10, recentProjectedExhaustAt: now + 10 * HOUR },
          },
          {
            id: "watch",
            label: "Monthly",
            scope: { provider: "openai-codex" },
            window: { resetsAt: now + 10 * 24 * HOUR },
            amount: { usedFraction: 0.7 },
            intelligence: { status: "watch" },
          },
        ],
      }],
    },
    now,
  });
  const summary = overview.capacity[0];
  assert.equal(summary.exhaustedCount, 1);
  assert.equal(summary.atRiskCount, 1);
  assert.equal(summary.watchCount, 1);
  assert.equal(summary.resetCreditsAvailable, 2);
});

test("incomplete data does not render a false all-clear state", () => {
  const previous = getLocale();
  try {
    setLocale("en");
    const screen = stripAnsi(renderView("overview", {
      stats: undefined,
      statsState: { refreshing: true, startedAt: Date.now() },
      quota: undefined,
      events: [],
    }, 120).join("\n"));
    assert.match(screen, /Collecting enough data to assess system health/);
    assert.doesNotMatch(screen, /No actionable anomalies detected/);
  } finally {
    setLocale(previous);
  }
});


test("high-impact cache alert catches a dominant 50% hit model that masks its provider average", () => {
  const stats = normalizeStats({
    overall: { cacheRate: 0.67, totalInputTokens: 81_000_000, totalCacheReadTokens: 165_000_000 },
    byModel: [
      { provider: "openai-codex", model: "gpt-6-astra", totalRequests: 1090, totalInputTokens: 72_500_000, totalCacheReadTokens: 73_300_000, totalCacheWriteTokens: 0, cacheRate: 0.503 },
      { provider: "openai-codex", model: "gpt-6.1-sol", totalRequests: 50, totalInputTokens: 360_000, totalCacheReadTokens: 2_650_000, totalCacheWriteTokens: 0, cacheRate: 0.88 },
      { provider: "google-antigravity", model: "gemini-3.8-flash", totalRequests: 680, totalInputTokens: 7_000_000, totalCacheReadTokens: 89_200_000, totalCacheWriteTokens: 0, cacheRate: 0.927 },
    ],
  });
  const diagnostics = {
    overall: { requests: 1820, uncachedInputTokens: 80_000_000, cacheReadTokens: 165_150_000, cacheWriteTokens: 0, cacheRate: 0.674 },
    byModel: [
      { provider: "openai-codex", model: "gpt-6-astra", requests: 1090, uncachedInputTokens: 72_500_000, cacheReadTokens: 73_300_000, cacheWriteTokens: 0, cacheRate: 0.503, uncachedShare: 0.90625 },
      { provider: "openai-codex", model: "gpt-6.1-sol", requests: 50, uncachedInputTokens: 360_000, cacheReadTokens: 2_650_000, cacheWriteTokens: 0, cacheRate: 0.88, uncachedShare: 0.0045 },
      { provider: "google-antigravity", model: "gemini-3.8-flash", requests: 680, uncachedInputTokens: 7_000_000, cacheReadTokens: 89_200_000, cacheWriteTokens: 0, cacheRate: 0.927, uncachedShare: 0.0875 },
    ],
    byAgentModel: [
      { provider: "openai-codex", model: "gpt-6-astra", agentType: "main", requests: 700, uncachedInputTokens: 20_000_000, cacheReadTokens: 50_000_000 },
      { provider: "openai-codex", model: "gpt-6-astra", agentType: "subagent", requests: 390, uncachedInputTokens: 52_500_000, cacheReadTokens: 23_300_000 },
    ],
    byFolderModel: [
      { provider: "openai-codex", model: "gpt-6-astra", folder: "/work/artland", requests: 600, uncachedInputTokens: 45_000_000, cacheReadTokens: 20_000_000 },
      { provider: "openai-codex", model: "gpt-6-astra", folder: "/work/other", requests: 490, uncachedInputTokens: 27_500_000, cacheReadTokens: 53_300_000 },
    ],
    bySessionModel: [
      { provider: "openai-codex", model: "gpt-6-astra", folder: "/work/artland", sessionFile: "/work/artland/session-a.jsonl", requests: 300, uncachedInputTokens: 30_000_000, cacheReadTokens: 10_000_000 },
    ],
  };

  const overview = buildOverviewIntelligence({ stats, cacheDiagnostics: diagnostics });
  const alert = overview.alerts.find(item => item.kind === "cache-impact");
  assert.ok(alert);
  assert.equal(alert.model, "gpt-6-astra");
  assert.equal(alert.severity, "warning");
  assert.ok(alert.uncachedShare > 0.9);
  assert.ok(alert.diagnosis.likely.some(item => item.kind === "agent-concentration"));
  assert.ok(alert.diagnosis.likely.some(item => item.kind === "project-concentration"));
});

test("Vietnamese cache intelligence uses natural technical wording", () => {
  const previous = getLocale();
  try {
    setLocale("vi");
    const stats = normalizeStats({
      overall: { cacheRate: 0.5, totalInputTokens: 20_000_000, totalCacheReadTokens: 20_000_000 },
      byModel: [{ provider: "openai-codex", model: "gpt-6-astra", totalRequests: 100, totalInputTokens: 18_000_000, totalCacheReadTokens: 18_000_000, cacheRate: 0.5 }],
    });
    const diagnostics = {
      overall: { uncachedInputTokens: 20_000_000, cacheReadTokens: 20_000_000, cacheRate: 0.5 },
      byModel: [{ provider: "openai-codex", model: "gpt-6-astra", requests: 100, uncachedInputTokens: 18_000_000, cacheReadTokens: 18_000_000, cacheWriteTokens: 0, cacheRate: 0.5, uncachedShare: 0.9 }],
      byAgentModel: [], byFolderModel: [], bySessionModel: [],
    };
    const screen = stripAnsi(renderView("overview", { stats, cacheDiagnostics: diagnostics, quota: { reports: [] }, events: [], statsState: {} }, 156).join("\n"));
    assert.match(screen, /OpenAI Codex\/gpt-6-astra · 18\.0M uncached \(90%\)/);
    assert.match(screen, /→ kiểm tra Cache · 4 Cache/);
    assert.doesNotMatch(screen, /Khuyến nghị:/);
  } finally {
    setLocale(previous);
  }
});


test("provider capacity keeps ETA and reset on the same quota window", () => {
  const now = Date.now();
  const worstReset = now + (4 * 24 + 9) * HOUR;
  const overview = buildOverviewIntelligence({
    stats: normalizeStats({ byModel: [] }),
    quota: {
      reports: [{
        provider: "google-antigravity",
        limits: [
          {
            id: "gemini",
            label: "Gemini",
            scope: { provider: "google-antigravity" },
            window: { resetsAt: worstReset },
            amount: { usedFraction: 0.28 },
            intelligence: {
              status: "at-risk",
              recentEtaHours: 4 * 24 + 1,
              recentProjectedExhaustAt: now + (4 * 24 + 1) * HOUR,
            },
          },
          {
            id: "other",
            label: "Other pool",
            scope: { provider: "google-antigravity" },
            window: { resetsAt: now + 5 * HOUR },
            amount: { usedFraction: 0.1 },
            intelligence: { status: "ok" },
          },
        ],
      }],
    },
    now,
  });
  const summary = overview.capacity[0];
  assert.equal(summary.worst.label, "Gemini");
  assert.equal(summary.resetAt, worstReset);
  assert.equal(summary.earliestProviderResetAt, now + 5 * HOUR);
  const alert = overview.alerts.find(item => item.kind === "quota-runway");
  assert.ok(alert);
  assert.ok(alert.runwayMarginHours > 7.9 && alert.runwayMarginHours < 8.1);
  assert.equal(alert.severity, "warning");
  assert.equal(alert.actionLevel, "reduce");
});

test("reset-due exhausted quota asks for refresh instead of waiting for reset", () => {
  const now = Date.now();
  const overview = buildOverviewIntelligence({
    stats: normalizeStats({ byModel: [] }),
    quota: {
      reports: [{
        provider: "anthropic",
        limits: [{
          id: "weekly",
          label: "Claude 7 Day",
          scope: { provider: "anthropic" },
          window: { resetsAt: now - 60_000 },
          amount: { usedFraction: 1 },
          intelligence: { status: "exhausted", resetsAt: now - 60_000 },
        }],
      }],
    },
    now,
  });
  const alert = overview.alerts.find(item => item.kind === "quota-reset-due");
  assert.ok(alert);
  assert.equal(alert.severity, "warning");

  const previous = getLocale();
  try {
    setLocale("vi");
    const screen = stripAnsi(renderView("overview", {
      stats: normalizeStats({ byModel: [] }),
      quota: {
        reports: [{
          provider: "anthropic",
          limits: [{
            id: "weekly",
            label: "Claude 7 Day",
            scope: { provider: "anthropic" },
            window: { resetsAt: now - 60_000 },
            amount: { usedFraction: 1 },
            intelligence: { status: "exhausted", resetsAt: now - 60_000 },
          }],
        }],
      },
      events: [],
      statsState: {},
    }, 120).join("\n"));
    assert.match(screen, /đã tới giờ reset/);
    assert.match(screen, /→ refresh Quota · 2 Quota/);
    assert.doesNotMatch(screen, /cho tới khi quota được reset/);
  } finally {
    setLocale(previous);
  }
});

test("request rate at 4x baseline becomes an Attention signal", () => {
  const now = Date.now();
  const stats = normalizeStats({
    timeSeries: [
      ...[-10,-9,-8,-7,-6,-5,-4].map(h => ({ timestamp: now + h * HOUR, requests: 2 })),
      ...[-2,-1,0].map(h => ({ timestamp: now + h * HOUR, requests: 8 })),
    ],
    byModel: [],
  });
  const overview = buildOverviewIntelligence({ stats, now });
  const alert = overview.alerts.find(item => item.kind === "request-spike");
  assert.ok(alert);
  assert.equal(alert.severity, "warning");
  assert.ok(alert.ratio >= 4);
});

test("cache Overview evidence names a concrete sibling and strongest likely contributor", () => {
  const previous = getLocale();
  try {
    setLocale("vi");
    const stats = normalizeStats({
      overall: { cacheRate: 0.67 },
      byModel: [
        { provider: "openai-codex", model: "gpt-6-astra", totalRequests: 1090, totalInputTokens: 72_500_000, totalCacheReadTokens: 73_300_000, totalCacheWriteTokens: 1, cacheRate: 0.503 },
        { provider: "openai-codex", model: "gpt-6.1-sol", totalRequests: 50, totalInputTokens: 360_000, totalCacheReadTokens: 2_650_000, totalCacheWriteTokens: 1, cacheRate: 0.88 },
      ],
    });
    const diagnostics = {
      overall: { uncachedInputTokens: 72_860_000, cacheReadTokens: 75_950_000, cacheRate: 0.51 },
      byModel: [
        { provider: "openai-codex", model: "gpt-6-astra", requests: 1090, uncachedInputTokens: 72_500_000, cacheReadTokens: 73_300_000, cacheWriteTokens: 1, cacheRate: 0.503 },
        { provider: "openai-codex", model: "gpt-6.1-sol", requests: 50, uncachedInputTokens: 360_000, cacheReadTokens: 2_650_000, cacheWriteTokens: 1, cacheRate: 0.88 },
      ],
      byAgentModel: [
        { provider: "openai-codex", model: "gpt-6-astra", agentType: "subagent", uncachedInputTokens: 50_000_000, cacheReadTokens: 10_000_000, requests: 500 },
        { provider: "openai-codex", model: "gpt-6-astra", agentType: "main", uncachedInputTokens: 22_500_000, cacheReadTokens: 63_300_000, requests: 590 },
      ],
      byFolderModel: [],
      bySessionModel: [],
    };
    const screen = stripAnsi(renderView("overview", {
      stats,
      cacheDiagnostics: diagnostics,
      quota: { reports: [] },
      events: [],
      statsState: {},
    }, 120).join("\n"));
    assert.match(screen, /vs gpt-6\.1-sol 88%/);
    assert.match(screen, /subagent tạo 69% uncached input/);
    assert.doesNotMatch(screen, /provider\/peer/);
  } finally {
    setLocale(previous);
  }
});

test("small model-failure samples are described as small samples, not uncertain failures", () => {
  const previous = getLocale();
  try {
    setLocale("vi");
    const stats = normalizeStats({
      byModel: [{
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        totalRequests: 4,
        successfulRequests: 0,
        failedRequests: 4,
        errorRate: 1,
      }],
    });
    const screen = stripAnsi(renderView("overview", { stats, quota: { reports: [] }, events: [], statsState: {} }, 120).join("\n"));
    assert.match(screen, /lỗi 4\/4 · mẫu nhỏ/);
    assert.doesNotMatch(screen, /chưa đủ để kết luận/);
    assert.doesNotMatch(screen, /mức chắc chắn thấp/);
  } finally {
    setLocale(previous);
  }
});


test("Overview stays within a compact line budget under multiple alerts", () => {
  const fixture = decisionFixture();
  const screen = stripAnsi(renderView("overview", fixture, 156).join("\n"));
  const lines = screen.split("\n");
  assert.ok(lines.length <= 26, `Overview rendered ${lines.length} lines`);
  assert.doesNotMatch(screen, /Recommendation:/);
  assert.doesNotMatch(screen, /workload attribution, not direct/);
});
