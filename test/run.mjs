import assert from "node:assert/strict";
import { extractJsonPayload, parseNoisyJson } from "../src/json.mjs";
import { aggregateCacheByProvider } from "../src/stats.mjs";
import { snapshotsToQuota, mergeProviderReports, quotaDisplayGroups } from "../src/quota.mjs";
import { versionFromReleaseTag, releaseAssetNames, parseSha256 } from "../src/self.mjs";
import { OmpTopApp } from "../src/top.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`✓ ${name}\n`); }
  catch (error) { process.stderr.write(`✗ ${name}\n${error.stack || error}\n`); process.exitCode = 1; }
}

await test("extractJsonPayload ignores omp banners", () => {
  assert.equal(extractJsonPayload('Synced 2 entries\n\n{"ok":true}\n'), '{"ok":true}');
  assert.deepEqual(parseNoisyJson('warning\n{"x":[1,2]}', "probe"), { x: [1, 2] });
});

await test("provider cache rate is token weighted", () => {
  const rows = aggregateCacheByProvider([
    { provider: "openai-codex", totalRequests: 10, totalInputTokens: 900, totalCacheReadTokens: 100, totalCacheWriteTokens: 0 },
    { provider: "openai-codex", totalRequests: 1, totalInputTokens: 0, totalCacheReadTokens: 100, totalCacheWriteTokens: 0 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalRequests, 11);
  assert.ok(Math.abs(rows[0].cacheRate - 200 / 1100) < 1e-9);
});

await test("snapshot history keeps latest account/window and reset", () => {
  const base = { provider: "anthropic", accountKey: "acct", email: "a@example.test", accountId: "acct", limitId: "5h", label: "5 Hour", windowLabel: "5 Hour", status: "ok" };
  const payload = snapshotsToQuota([
    { ...base, recordedAt: 1000, usedFraction: 0.2, resetsAt: 5000 },
    { ...base, recordedAt: 2000, usedFraction: 0.7, resetsAt: 6000 },
  ]);
  assert.equal(payload.reports.length, 1);
  assert.equal(payload.reports[0].fetchedAt, 2000);
  assert.equal(payload.reports[0].limits[0].amount.usedFraction, 0.7);
  assert.equal(payload.reports[0].limits[0].window.resetsAt, 6000);
});

await test("progressive provider merge never drops another provider", () => {
  const payload = {
    generatedAt: 100,
    reports: [
      { provider: "anthropic", fetchedAt: 90, metadata: { email: "claude@test" }, limits: [{ id: "5h", amount: { usedFraction: 0.4 } }] },
      { provider: "openai-codex", fetchedAt: 100, metadata: { email: "codex@test", planType: "pro" }, limits: [{ id: "5h", window: { resetsAt: 9999 }, amount: { usedFraction: 0.2 } }] },
    ],
  };
  const merged = mergeProviderReports(payload, "openai-codex", [
    { provider: "openai-codex", fetchedAt: 200, metadata: { email: "codex@test" }, limits: [{ id: "5h", amount: { usedFraction: 0.8 } }] },
  ]);
  assert.ok(merged.reports.some(r => r.provider === "anthropic"));
  const codex = merged.reports.find(r => r.provider === "openai-codex");
  assert.equal(codex.metadata.planType, "pro");
  assert.equal(codex.limits[0].window.resetsAt, 9999);
  assert.equal(codex.limits[0].amount.usedFraction, 0.8);
});

await test("GitHub release helpers normalize version and assets", () => {
  assert.equal(versionFromReleaseTag("v0.5.0"), "0.5.0");
  assert.deepEqual(releaseAssetNames("v0.5.0"), {
    version: "0.5.0",
    archive: "omp-top-v0.5.0.tar.gz",
    checksum: "omp-top-v0.5.0.tar.gz.sha256",
    root: "omp-top-0.5.0",
  });
  assert.equal(parseSha256("a".repeat(64) + "  omp-top-v0.5.0.tar.gz\n"), "a".repeat(64));
});

await test("GitHub release helper rejects malformed tags/checksums", () => {
  assert.throws(() => versionFromReleaseTag("latest"));
  assert.throws(() => parseSha256("not-a-checksum"));
});

await test("refresh path starts progressive quota without a missing-method crash", async () => {
  let quotaStarts = 0;
  let draws = 0;
  const fakeUi = {
    rows: 24,
    start() {},
    stop() {},
    draw() { draws++; },
  };
  const app = new OmpTopApp({
    ui: fakeUi,
    deps: {
      fetchStats: async () => ({ overall: {}, byModel: [] }),
      loadHistoricalQuota: async () => ({ payload: undefined }),
      createQuotaRefresh: () => ({
        cancel() {},
        run: async () => { quotaStarts++; },
      }),
    },
  });
  await app.refresh();
  await Promise.resolve();
  assert.equal(quotaStarts, 1);
  assert.ok(draws >= 1);
  app.dispose();
});


await test("first-load stats state is visible inline and not mislabeled unavailable", async () => {
  let resolveStats;
  const pendingStats = new Promise(resolve => { resolveStats = resolve; });
  const fakeUi = { rows: 28, start() {}, stop() {}, draw() {} };
  const app = new OmpTopApp({
    ui: fakeUi,
    deps: {
      fetchStats: () => pendingStats,
      loadHistoricalQuota: async () => ({ payload: undefined }),
      createQuotaRefresh: () => ({ cancel() {}, run: async () => {} }),
    },
  });
  await app.refresh();
  const screen = app.render(220, 28).join("\n");
  assert.ok(screen.includes("ATTENTION"));
  assert.ok(screen.includes("calculating"));
  assert.ok(screen.includes("First load may take a while"));
  assert.ok(!screen.includes("Stats unavailable"));
  resolveStats({ overall: {}, byModel: [] });
  await Promise.resolve();
  app.dispose();
});

await test("wide terminal keeps header metadata inside logical dashboard width", () => {
  const fakeUi = { rows: 28, start() {}, stop() {}, draw() {} };
  const app = new OmpTopApp({
    ui: fakeUi,
    deps: {
      fetchStats: async () => ({ overall: {}, byModel: [] }),
      loadHistoricalQuota: async () => ({ payload: undefined }),
      createQuotaRefresh: () => ({ cancel() {}, run: async () => {} }),
    },
  });
  const header = app.render(240, 28)[0].replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(header.startsWith(" ".repeat(40) + "╭"));
  assert.equal(header.trimStart().length, 160);
  app.dispose();
});

await test("Antigravity display groups expose Gemini and shared Claude/GPT quota", () => {
  const report = {
    provider: "google-antigravity",
    limits: [
      { id: "google-antigravity:google:default:gemini-weekly", label: "Gemini", scope: { windowId: "weekly" }, window: { id: "weekly", label: "Weekly" }, amount: { usedFraction: 0.34 } },
      { id: "google-antigravity:google:default:gemini-5h", label: "Gemini", scope: { windowId: "5h" }, window: { id: "5h", label: "5 Hour" }, amount: { usedFraction: 0 } },
      { id: "google-antigravity:anthropic:default:3p-weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true, sharedGroup: "3p-weekly:weekly" }, window: { id: "weekly", label: "Weekly" }, amount: { usedFraction: 0.17 } },
      { id: "google-antigravity:openai:default:3p-weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true, sharedGroup: "3p-weekly:weekly" }, window: { id: "weekly", label: "Weekly" }, amount: { usedFraction: 0.17 } },
      { id: "google-antigravity:anthropic:default:3p-5h", label: "Claude & GPT (shared)", scope: { windowId: "5h", shared: true, sharedGroup: "3p-5h:5h" }, window: { id: "5h", label: "5 Hour" }, amount: { usedFraction: 0 } },
      { id: "google-antigravity:openai:default:3p-5h", label: "Claude & GPT (shared)", scope: { windowId: "5h", shared: true, sharedGroup: "3p-5h:5h" }, window: { id: "5h", label: "5 Hour" }, amount: { usedFraction: 0 } },
    ],
  };
  const groups = quotaDisplayGroups(report);
  assert.deepEqual(groups.map(group => [group.label, group.limits.length]), [
    ["Gemini", 2],
    ["Claude & GPT (shared)", 2],
  ]);
  assert.deepEqual(groups[0].limits.map(limit => limit.window.label), ["Weekly", "5 Hour"]);
  assert.deepEqual(groups[1].limits.map(limit => limit.window.label), ["Weekly", "5 Hour"]);
});

await test("Antigravity progressive history dedupes shared routing copies by label and window", () => {
  const rows = [
    { recordedAt: 1000, provider: "google-antigravity", accountKey: "a", email: "a@test", accountId: "a", limitId: "google-antigravity:google:default:gemini-weekly", label: "Gemini", windowLabel: "Weekly", usedFraction: 0.34, status: "ok", resetsAt: 5000 },
    { recordedAt: 1000, provider: "google-antigravity", accountKey: "a", email: "a@test", accountId: "a", limitId: "google-antigravity:google:default:gemini-5h", label: "Gemini", windowLabel: "5 Hour", usedFraction: 0, status: "ok", resetsAt: 5000 },
    { recordedAt: 1000, provider: "google-antigravity", accountKey: "a", email: "a@test", accountId: "a", limitId: "google-antigravity:anthropic:default:3p-weekly", label: "Claude & GPT (shared)", windowLabel: "Weekly", usedFraction: 0.12, status: "ok", resetsAt: 5000 },
    { recordedAt: 1000, provider: "google-antigravity", accountKey: "a", email: "a@test", accountId: "a", limitId: "google-antigravity:openai:default:3p-weekly", label: "Claude & GPT (shared)", windowLabel: "Weekly", usedFraction: 0.17, status: "ok", resetsAt: 5000 },
    { recordedAt: 1000, provider: "google-antigravity", accountKey: "a", email: "a@test", accountId: "a", limitId: "google-antigravity:anthropic:default:3p-5h", label: "Claude & GPT (shared)", windowLabel: "5 Hour", usedFraction: 0, status: "ok", resetsAt: 5000 },
    { recordedAt: 1000, provider: "google-antigravity", accountKey: "a", email: "a@test", accountId: "a", limitId: "google-antigravity:openai:default:3p-5h", label: "Claude & GPT (shared)", windowLabel: "5 Hour", usedFraction: 0, status: "ok", resetsAt: 5000 },
  ];
  const payload = snapshotsToQuota(rows);
  const groups = quotaDisplayGroups(payload.reports[0]);
  assert.deepEqual(groups.map(group => [group.label, group.limits.length]), [
    ["Gemini", 2],
    ["Claude & GPT (shared)", 2],
  ]);
  const weekly = groups[1].limits.find(limit => limit.window.label === "Weekly");
  assert.equal(weekly.amount.usedFraction, 0.17);
});
