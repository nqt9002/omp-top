import assert from "node:assert/strict";
import test from "node:test";
import { quotaIntelligenceForSeries, modelPerformanceRows } from "../src/intelligence.mjs";
import { snapshotsToQuota, enrichQuotaPayload } from "../src/quota.mjs";
import { normalizeStats } from "../src/stats.mjs";
import { directViewIndex, nextViewIndex, renderView } from "../src/views.mjs";
import { OmpTopApp } from "../src/top.mjs";
import { Keys } from "../src/tui.mjs";
import { stripAnsi, visibleWidth } from "../src/format.mjs";

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

test("responsive shell stays inside physical width and centers wide workspaces", () => {
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
  assert.ok(stripAnsi(wide[0]).startsWith(" ".repeat(30) + "╭"));
  assert.match(stripAnsi(wide[1]), /▌ Overview/);
  assert.match(stripAnsi(wide.at(-2)), /1–6 view/);
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
