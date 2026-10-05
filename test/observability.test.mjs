import assert from "node:assert/strict";
import test from "node:test";
import { quotaIntelligenceForSeries, modelPerformanceRows } from "../src/intelligence.mjs";
import { snapshotsToQuota, enrichQuotaPayload } from "../src/quota.mjs";
import { normalizeStats } from "../src/stats.mjs";
import { directViewIndex, nextViewIndex, renderView } from "../src/views.mjs";
import { OmpTopApp } from "../src/top.mjs";
import { Keys } from "../src/tui.mjs";
import { stripAnsi, visibleWidth } from "../src/format.mjs";
import { getLocale, setLocale } from "../src/i18n.mjs";

const HOUR = 60 * 60 * 1000;
const baseRow = { provider: "openai-codex", accountKey: "a", accountId: "a", limitId: "weekly", label: "Weekly", windowLabel: "Weekly", status: "ok" };

test("quota intelligence calculates burn, runway and unsafe pace", () => {
  const t = 1_800_000_000_000;
  const intel = quotaIntelligenceForSeries([
    { ...baseRow, recordedAt: t, usedFraction: 0.2, resetsAt: t + 10 * HOUR },
    { ...baseRow, recordedAt: t + 2 * HOUR, usedFraction: 0.4, resetsAt: t + 10 * HOUR },
  ]);
  assert.ok(Math.abs(intel.burnPerHour - 0.1) < 1e-9);
  assert.ok(Math.abs(intel.etaHours - 6) < 1e-9);
  assert.ok(Math.abs(intel.sustainablePerHour - 0.075) < 1e-9);
  assert.ok(intel.paceRatio > 1.3 && intel.paceRatio < 1.34);
  assert.equal(intel.status, "at-risk");
});

test("quota intelligence starts a new cycle after a reset", () => {
  const t = 1_800_000_000_000;
  const oldReset = t + HOUR;
  const newReset = t + 12 * HOUR;
  const intel = quotaIntelligenceForSeries([
    { ...baseRow, recordedAt: t, usedFraction: 0.8, resetsAt: oldReset },
    { ...baseRow, recordedAt: t + 2 * HOUR, usedFraction: 0.1, resetsAt: newReset },
    { ...baseRow, recordedAt: t + 4 * HOUR, usedFraction: 0.2, resetsAt: newReset },
  ]);
  assert.equal(intel.sampleCount, 2);
  assert.ok(Math.abs(intel.burnPerHour - 0.05) < 1e-9);
});

test("quota intelligence is safe with insufficient history", () => {
  const intel = quotaIntelligenceForSeries([{ ...baseRow, recordedAt: Date.now(), usedFraction: 0.4 }]);
  assert.equal(intel.sampleCount, 1);
  assert.equal(intel.burnPerHour, undefined);
  assert.equal(intel.etaHours, undefined);
  assert.equal(intel.status, "unknown");
});

test("fresh reset cycle drops stale exhausted history intelligence", () => {
  const t = 1_800_000_000_000;
  const historical = {
    reports: [{
      provider: "anthropic",
      fetchedAt: t,
      metadata: { accountId: "a" },
      limits: [{
        id: "anthropic:7d",
        label: "Claude 7 Day",
        window: { label: "7 Day", resetsAt: t + HOUR },
        amount: { usedFraction: 1, unit: "percent" },
        status: "exhausted",
        intelligence: {
          usedFraction: 1,
          remainingFraction: 0,
          resetsAt: t + HOUR,
          status: "exhausted",
          burnPerHour: 0.1,
          recentBurnPerHour: 0.1,
        },
      }],
    }],
  };
  const fresh = {
    generatedAt: t + 2 * HOUR,
    reports: [{
      provider: "anthropic",
      fetchedAt: t + 2 * HOUR,
      metadata: { accountId: "a" },
      limits: [{
        id: "anthropic:7d",
        label: "Claude 7 Day",
        window: { label: "7 Day", resetsAt: t + 8 * 24 * HOUR },
        amount: { usedFraction: 0, remainingFraction: 1, unit: "percent" },
        status: "ok",
      }],
    }],
  };
  const enriched = enrichQuotaPayload(fresh, historical);
  const limit = enriched.reports[0].limits[0];
  assert.equal(limit.amount.usedFraction, 0);
  assert.equal(limit.status, "ok");
  assert.equal(limit.intelligence, undefined);
});

test("compatible historical intelligence rebases onto fresh same-cycle usage", () => {
  const t = 1_800_000_000_000;
  const reset = t + 10 * HOUR;
  const historical = {
    reports: [{
      provider: "openai-codex",
      fetchedAt: t,
      metadata: { accountId: "a" },
      limits: [{
        id: "weekly",
        label: "Weekly",
        window: { label: "Weekly", resetsAt: reset },
        amount: { usedFraction: 0.4, unit: "percent" },
        intelligence: {
          usedFraction: 0.4,
          remainingFraction: 0.6,
          resetsAt: reset,
          burnPerHour: 0.05,
          recentBurnPerHour: 0.05,
          status: "ok",
        },
      }],
    }],
  };
  const fresh = {
    generatedAt: t + HOUR,
    reports: [{
      provider: "openai-codex",
      fetchedAt: t + HOUR,
      metadata: { accountId: "a" },
      limits: [{
        id: "weekly",
        label: "Weekly",
        window: { label: "Weekly", resetsAt: reset },
        amount: { usedFraction: 0.45, remainingFraction: 0.55, unit: "percent" },
        status: "ok",
      }],
    }],
  };
  const enriched = enrichQuotaPayload(fresh, historical);
  const intel = enriched.reports[0].limits[0].intelligence;
  assert.ok(intel);
  assert.equal(intel.usedFraction, 0.45);
  assert.equal(intel.remainingFraction, 0.55);
  assert.ok(intel.etaHours > 10.9 && intel.etaHours < 11.1);
  assert.notEqual(intel.status, "exhausted");
});

test("history intelligence survives enrichment of authoritative final quota", () => {
  const t = 1_800_000_000_000;
  const historical = snapshotsToQuota([
    { ...baseRow, recordedAt: t, usedFraction: 0.2, resetsAt: t + 10 * HOUR },
    { ...baseRow, recordedAt: t + 2 * HOUR, usedFraction: 0.4, resetsAt: t + 10 * HOUR },
  ]);
  const finalPayload = { generatedAt: t + 2 * HOUR, reports: [{ provider: "openai-codex", fetchedAt: t + 2 * HOUR, metadata: { accountId: "a", planType: "pro" }, limits: [{ id: "weekly", label: "Weekly", window: { label: "Weekly", resetsAt: t + 10 * HOUR }, amount: { usedFraction: 0.41 } }] }] };
  const enriched = enrichQuotaPayload(finalPayload, historical);
  assert.equal(enriched.reports[0].metadata.planType, "pro");
  assert.ok(enriched.reports[0].limits[0].intelligence);
  assert.equal(enriched.reports[0].limits[0].amount.usedFraction, 0.41);
});

test("stats normalization keeps performance, time-series and agent dimensions", () => {
  const normalized = normalizeStats({ overall: { totalRequests: 2 }, byModel: [{ model: "x" }], byAgentType: [{ agentType: "task" }], timeSeries: [{ requests: 2 }] });
  assert.equal(normalized.byModel.length, 1);
  assert.equal(normalized.byAgentType.length, 1);
  assert.equal(normalized.timeSeries.length, 1);
  assert.deepEqual(normalized.costSeries, []);
});

test("model performance rows preserve OMP performance metrics", () => {
  const rows = modelPerformanceRows({ byModel: [{ provider: "openai-codex", model: "gpt", totalRequests: 7, errorRate: 0.1, avgTtft: 250, avgDuration: 1000, avgTokensPerSecond: 42, totalCost: 1.25 }] });
  assert.equal(rows[0].avgTokensPerSecond, 42);
  assert.equal(rows[0].avgTtft, 250);
  assert.equal(rows[0].totalCost, 1.25);
});

test("view helpers support direct keys and circular navigation", () => {
  assert.equal(directViewIndex("1"), 0);
  assert.equal(directViewIndex("6"), 5);
  assert.equal(nextViewIndex(0, -1), 5);
  assert.equal(nextViewIndex(5, 1), 0);
});

test("model view renders performance columns and narrow fallback", () => {
  const stats = normalizeStats({ byModel: [{ provider: "openai-codex", model: "gpt-test", totalRequests: 7, errorRate: 0.1, avgTtft: 250, avgDuration: 1000, avgTokensPerSecond: 42, totalCost: 1.25 }] });
  const wide = stripAnsi(renderView("models", { stats }, 156).join("\n"));
  const narrow = stripAnsi(renderView("models", { stats }, 60).join("\n"));
  assert.match(wide, /MODEL PERFORMANCE/);
  assert.match(wide, /TTFT/);
  assert.match(wide, /API est\./);
  assert.match(narrow, /TPS 42\.0/);
});

test("app switches views with number, Tab and Shift+Tab without treating Shift+Tab as Escape", () => {
  const fakeUi = { rows: 28, start() {}, stop() {}, draw() {} };
  const app = new OmpTopApp({ version: "0.6.0-beta.1", channel: "beta", ui: fakeUi, deps: {
    fetchStats: async () => ({ overall: {}, byModel: [] }),
    loadHistoricalQuota: async () => ({ payload: undefined }),
    createQuotaRefresh: () => ({ cancel() {}, run: async () => {} }),
  } });
  app.handleInput("2");
  assert.match(stripAnsi(app.render(112, 28).join("\n")), /QUOTA \/ RUNWAY/);
  app.handleInput(Keys.shiftTab);
  assert.match(stripAnsi(app.render(112, 28).join("\n")), /ATTENTION/);
  app.handleInput(Keys.tab);
  assert.match(stripAnsi(app.render(112, 28).join("\n")), /QUOTA \/ RUNWAY/);
  app.dispose();
});

test("responsive shell uses wide workspaces without overflowing", () => {
  const fakeUi = { rows: 32, start() {}, stop() {}, draw() {} };
  const app = new OmpTopApp({ version: "0.6.0-beta.2", channel: "beta", ui: fakeUi, deps: {
    fetchStats: async () => ({ overall: {}, byModel: [] }), loadHistoricalQuota: async () => ({ payload: undefined }), createQuotaRefresh: () => ({ cancel() {}, run: async () => {} }),
  } });
  for (const width of [60, 112, 220]) {
    const lines = app.render(width, 32);
    assert.equal(lines.length, 32);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(stripAnsi(lines[0]).trimStart().startsWith("╭"));
    assert.ok(stripAnsi(lines.at(-1)).trimStart().startsWith("╰"));
  }
  const wide = app.render(220, 32);
  assert.ok(stripAnsi(wide[0]).startsWith("╭"));
  assert.match(stripAnsi(wide[1]), /▌ 1 Overview/);
  assert.match(stripAnsi(wide.at(-2)), /Enter inspect/);
  app.dispose();
});

test("overview is anomaly-first and does not duplicate the detailed model table", () => {
  const stats = normalizeStats({
    overall: { totalRequests: 100, cacheRate: 0.66, errorRate: 0.004, avgTtft: 6500, avgDuration: 16000, avgTokensPerSecond: 45.9, totalInputTokens: 1000, totalOutputTokens: 500, totalCost: 12.34 },
    byModel: [{ provider: "openai-codex", model: "gpt-6-astra", totalRequests: 90, failedRequests: 0, errorRate: 0, avgTtft: 500, avgTokensPerSecond: 50, totalCost: 10 }],
  });
  const now = Date.now();
  const quota = {
    reports: [{
      provider: "openai-codex",
      metadata: { accountId: "a" },
      limits: [{
        id: "done",
        label: "Weekly",
        scope: { provider: "openai-codex" },
        window: { resetsAt: now + 2 * HOUR },
        amount: { usedFraction: 1 },
        intelligence: { status: "exhausted", usedFraction: 1, resetsAt: now + 2 * HOUR },
      }],
    }],
  };
  const wide = stripAnsi(renderView("overview", { stats, statsState: {}, quota, events: [] }, 156).join("\n"));
  assert.match(wide, /ATTENTION/);
  assert.match(wide, /OpenAI Codex · Weekly · 100% · reset/);
  assert.match(wide, /→ shift work · 2 Quota/);
  assert.match(wide, /CAPACITY \/ QUOTA/);
  assert.match(wide, /SYSTEM CONTEXT/);
  assert.doesNotMatch(wide, /TOP MODELS/);
});

test("compact cache and agent views use stacked fallbacks instead of wide tables", () => {
  const stats = normalizeStats({
    overall: { cacheRate: 0.5, totalCacheReadTokens: 1000, totalCacheWriteTokens: 200, cacheSavings: 0.4 },
    byModel: [{ provider: "openai-codex", model: "gpt-test", totalRequests: 7, totalInputTokens: 100, totalCacheReadTokens: 100, totalCacheWriteTokens: 20, cacheRate: 0.5, cacheSavings: 0.4 }],
    byAgentType: [{ agentType: "task", totalRequests: 7, totalInputTokens: 100, totalOutputTokens: 30, totalCacheReadTokens: 100, totalCost: 0.2 }],
  });
  const cache = stripAnsi(renderView("cache", { stats }, 56).join("\n"));
  const agents = stripAnsi(renderView("agents", { stats }, 56).join("\n"));
  assert.match(cache, /OpenAI Codex/);
  assert.match(cache, /req 7 · hit/);
  assert.match(agents, /task/);
  assert.match(agents, /share/);
});


test("quota view uses only decreasing countdowns for refresh reset and ETA", () => {
  const previous = getLocale();
  const now = 1_800_000_000_000;
  const resetAt = now + 2 * HOUR;
  const projectedAt = now + 90 * 60_000;
  const quota = {
    reports: [{
      provider: "anthropic",
      fetchedAt: now,
      metadata: { accountId: "a" },
      limits: [{
        id: "anthropic:5h",
        label: "Claude 5 Hour",
        scope: { provider: "anthropic", shared: true },
        window: { label: "5 Hour", resetsAt: resetAt },
        amount: { usedFraction: 0.23 },
        intelligence: {
          sampleCount: 3,
          status: "at-risk",
          recentBurnPerHour: 0.1,
          recentProjectedExhaustAt: projectedAt,
          sustainablePerHour: 0.4,
          recentPaceRatio: 0.25,
        },
      }],
    }],
  };
  const states = new Map([["anthropic", { status: "fresh", updatedAt: now }]]);

  try {
    setLocale("vi");
    const first = stripAnsi(renderView("quota", {
      quota,
      providerStates: states,
      quotaRefreshing: false,
      quotaNextAt: now + 5 * 60_000,
      now,
    }, 120).join("\n"));
    assert.doesNotMatch(first, /refresh ↻5p/);
    assert.match(first, /reset 2g/);
    assert.match(first, /ETA 1g 30p/);
    assert.doesNotMatch(first, /trước|reset ↻|ETA ↻/);

    const laterNow = now + 65_000;
    const later = stripAnsi(renderView("quota", {
      quota,
      providerStates: states,
      quotaRefreshing: false,
      quotaNextAt: now + 5 * 60_000,
      now: laterNow,
    }, 120).join("\n"));
    assert.doesNotMatch(later, /refresh ↻3p 55s/);
    assert.match(later, /reset 1g 58p/);
    assert.match(later, /ETA 1g 28p/);
    assert.doesNotMatch(later, /trước|reset ↻|ETA ↻/);
  } finally {
    setLocale(previous);
  }
});

test("past quota reset renders a fixed due state instead of counting upward", () => {
  const previous = getLocale();
  const now = 1_800_000_000_000;
  try {
    setLocale("vi");
    const screen = stripAnsi(renderView("quota", {
      quota: {
        reports: [{
          provider: "anthropic",
          fetchedAt: now,
          metadata: { accountId: "a" },
          limits: [{
            id: "anthropic:7d",
            label: "Claude 7 Day",
            scope: { provider: "anthropic", shared: true },
            window: { label: "7 Day", resetsAt: now - 5 * 60_000 },
            amount: { usedFraction: 1 },
            intelligence: { sampleCount: 2, status: "exhausted", recentBurnPerHour: 0.1 },
          }],
        }],
      },
      providerStates: new Map([["anthropic", { status: "fresh", updatedAt: now }]]),
      quotaRefreshing: false,
      quotaNextAt: now + 5 * 60_000,
      now,
    }, 120).join("\n"));
    assert.match(screen, /đã tới giờ reset/);
    assert.doesNotMatch(screen, /5p trước/);
  } finally {
    setLocale(previous);
  }
});
