import assert from "node:assert/strict";
import { extractJsonPayload, parseNoisyJson } from "../src/json.mjs";
import { aggregateCacheByProvider } from "../src/stats.mjs";
import { snapshotsToQuota, mergeProviderReports } from "../src/quota.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`✓ ${name}\n`); }
  catch (error) { process.stderr.write(`✗ ${name}\n${error.stack || error}\n`); process.exitCode = 1; }
}

test("extractJsonPayload ignores omp banners", () => {
  assert.equal(extractJsonPayload('Synced 2 entries\n\n{"ok":true}\n'), '{"ok":true}');
  assert.deepEqual(parseNoisyJson('warning\n{"x":[1,2]}', "probe"), { x: [1, 2] });
});

test("provider cache rate is token weighted", () => {
  const rows = aggregateCacheByProvider([
    { provider: "openai-codex", totalRequests: 10, totalInputTokens: 900, totalCacheReadTokens: 100, totalCacheWriteTokens: 0 },
    { provider: "openai-codex", totalRequests: 1, totalInputTokens: 0, totalCacheReadTokens: 100, totalCacheWriteTokens: 0 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalRequests, 11);
  assert.ok(Math.abs(rows[0].cacheRate - 200 / 1100) < 1e-9);
});

test("snapshot history keeps latest account/window and reset", () => {
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

test("progressive provider merge never drops another provider", () => {
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

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(`\n${passed} tests passed\n`);
