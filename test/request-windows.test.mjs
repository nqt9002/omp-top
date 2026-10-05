import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { loadRequestWindow, readRequestWindow } from "../src/request-windows.mjs";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 4, 12, 23);
function fixture(t, { output = true } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE messages (timestamp INTEGER, provider TEXT, model TEXT, agent_type TEXT,
    folder TEXT, session_file TEXT, input_tokens INTEGER, cache_read_tokens INTEGER,
    cache_write_tokens INTEGER${output ? ", output_tokens INTEGER" : ""})`);
  const insert = db.prepare(`INSERT INTO messages VALUES (${Array(output ? 10 : 9).fill("?").join(",")})`);
  return { db, add: (timestamp, overrides = {}) => {
    const row = { provider: "openai", model: "model-a", agentType: "main", folder: "/work", sessionFile: "one.json", input: 10, read: 20, write: 3, output: 4, ...overrides };
    const params = [timestamp, row.provider, row.model, row.agentType, row.folder, row.sessionFile, row.input, row.read, row.write];
    if (output) params.push(row.output);
    insert.run(...params);
  } };
}

for (const hours of [1, 6, 24]) {
  test(`${hours}h windows use exact [start,end) boundaries and previous duration`, t => {
    const { db, add } = fixture(t);
    const start = NOW - hours * HOUR;
    const previousStart = start - hours * HOUR;
    for (const timestamp of [previousStart - 1, previousStart, start - 1, start, NOW - 1, NOW, NOW + 1]) add(timestamp);
    const result = readRequestWindow(db, { hours, now: NOW });
    assert.equal(result.available, true);
    assert.equal(result.stats.overall.totalRequests, 2);
    assert.equal(result.stats.overall.totalInputTokens, 20);
    assert.equal(result.stats.overall.totalOutputTokens, 8);
    assert.equal(result.stats.overall.cacheRate, 2 / 3);
    assert.equal(result.diagnostics.overall.requests, 2);
    assert.equal(result.comparison.available, true);
    assert.equal(result.comparison.metrics.totalRequests.previous, 2);
    assert.equal(result.comparison.sinceMs, previousStart);
    assert.equal(result.comparison.untilMs, start);
    assert.equal(result.comparison.coverageVerified, false);
    assert.equal(result.comparison.scope, "observed-local-records");
    assert.match(result.comparison.note, /does not establish continuous ingestion/);
    assert.equal(result.stats.timeSeries.reduce((sum, row) => sum + row.requests, 0), 2);
    assert.ok(result.diagnostics.hourly.every(row => Number.isInteger(row.timestamp / HOUR)));
  });
}

test("all five filters are exact bound values, including quotes and empty strings", t => {
  const { db, add } = fixture(t);
  const filters = { provider: "p' OR 1=1 --", model: "model-a", folder: "", sessionFile: "one.json", agentType: "main" };
  add(NOW - 1, filters);
  for (const key of Object.keys(filters)) add(NOW - 1, { ...filters, [key]: `${filters[key]}other` });
  const result = readRequestWindow(db, { now: NOW, filters });
  assert.equal(result.available, true);
  assert.equal(result.stats.overall.totalRequests, 1);
  assert.equal(result.diagnostics.bySessionModel[0].folder, "");
  assert.equal(readRequestWindow(db, { now: NOW, filters: { invalid: "x" } }).available, false);
});

test("missing optional metrics remain unreported; null outputs are not complete totals", t => {
  const { db, add } = fixture(t, { output: false });
  add(NOW - 1);
  const result = readRequestWindow(db, { now: NOW });
  for (const key of ["totalOutputTokens", "totalCost", "errorRate", "avgTtftMs", "avgTokensPerSecond"]) assert.equal(Object.hasOwn(result.stats.overall, key), false);
  assert.deepEqual(result.stats.modelPerformanceSeries, []);
  assert.deepEqual(result.stats.costSeries, []);
  const withOutput = fixture(t);
  withOutput.add(NOW - 2);
  withOutput.add(NOW - 1, { output: null });
  assert.equal(Object.hasOwn(readRequestWindow(withOutput.db, { now: NOW }).stats.overall, "totalOutputTokens"), false);
});

test("short or filtered history cannot establish previous-window extent", t => {
  const { db, add } = fixture(t);
  add(NOW - 1);
  add(NOW - 100 * HOUR, { provider: "other" });
  const result = readRequestWindow(db, { now: NOW, filters: { provider: "openai" } });
  assert.equal(result.comparison.available, false);
  assert.match(result.comparison.reason, /does not reach/);
});

test("comparison calculates observed deltas with no percentage from a zero baseline", t => {
  const { db, add } = fixture(t);
  add(NOW - 100 * HOUR);
  add(NOW - 1);
  const result = readRequestWindow(db, { now: NOW });
  assert.equal(result.comparison.available, true);
  assert.deepEqual(result.comparison.metrics.totalRequests, { current: 1, previous: 0, delta: 1, percentChange: null });
  assert.deepEqual(Object.keys(result.comparison.metrics).sort(), ["totalCacheReadTokens", "totalCacheWriteTokens", "totalInputTokens", "totalRequests"].sort());
});

test("complete folder/session/model attribution is never truncated", t => {
  const { db, add } = fixture(t);
  for (let i = 0; i < 350; i++) add(NOW - 1, { folder: `/work/${i}`, sessionFile: `${i}.json` });
  const result = readRequestWindow(db, { now: NOW });
  assert.equal(result.diagnostics.byFolderModel.length, 350);
  assert.equal(result.diagnostics.bySessionModel.length, 350);
  assert.equal(result.diagnostics.bySessionModel.reduce((sum, row) => sum + row.uncachedInputTokens, 0), 3500);
  assert.equal(result.diagnostics.byAgentModel[0].requests, 350);
});

test("empty source is available, with empty diagnostics and unavailable comparison", t => {
  const { db } = fixture(t);
  const result = readRequestWindow(db, { now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.stats.overall.totalRequests, 0);
  assert.deepEqual(result.diagnostics.byModel, []);
  assert.deepEqual(result.diagnostics.bySessionModel, []);
  assert.equal(result.comparison.available, false);
});

test("absent database, invalid schema, and closed database fail gracefully", t => {
  assert.equal(readRequestWindow(undefined, { now: NOW }).available, false);
  const db = new DatabaseSync(":memory:");
  t.after(() => { try { db.close(); } catch {} });
  db.exec("CREATE TABLE messages (timestamp INTEGER)");
  assert.match(readRequestWindow(db, { now: NOW }).reason, /schema missing/);
  db.close();
  assert.equal(readRequestWindow(db, { now: NOW }).available, false);
});

test("loader fails gracefully when its runtime or database is unavailable", async () => {
  const result = await loadRequestWindow({ now: NOW });
  assert.equal(result.available, false);
  assert.equal(result.untilMs, NOW);
});

for (const field of ["input", "read", "write"]) {
  for (const invalid of [null, "not-a-counter", -1, 1.5, Infinity]) {
    test(`current ${field}=${invalid} makes counters unavailable`, t => {
      const { db, add } = fixture(t);
      add(NOW - 2);
      add(NOW - 1, { [field]: invalid });
      const result = readRequestWindow(db, { now: NOW });
      assert.equal(result.available, false);
      assert.match(result.reason, /Incomplete or invalid/);
      assert.deepEqual(result.stats.overall, {});
    });
  }
}

test("all-null current counters are unavailable, while empty windows have true zero", t => {
  const { db, add } = fixture(t);
  add(NOW - 1, { input: null, read: null, write: null });
  assert.equal(readRequestWindow(db, { now: NOW }).available, false);
  const empty = readRequestWindow(db, { now: NOW, filters: { provider: "absent" } });
  assert.equal(empty.available, true);
  assert.equal(empty.stats.overall.totalInputTokens, 0);
  assert.equal(empty.stats.overall.totalCacheReadTokens, 0);
  assert.equal(empty.stats.overall.totalCacheWriteTokens, 0);
});

test("partial prior counters disable comparison without hiding valid current records", t => {
  const { db, add } = fixture(t);
  add(NOW - 48 * HOUR);
  add(NOW - 25 * HOUR, { read: null });
  add(NOW - 1);
  const result = readRequestWindow(db, { now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.stats.overall.totalRequests, 1);
  assert.equal(result.comparison.available, false);
  assert.match(result.comparison.reason, /Previous window unavailable.*cache_read_tokens/);
  assert.equal(Object.hasOwn(result.comparison, "metrics"), false);
});

test("invalid counters outside selected window and filters do not poison totals", t => {
  const { db, add } = fixture(t);
  add(NOW - 100 * HOUR, { input: null });
  add(NOW - 1, { provider: "other", read: null });
  add(NOW - 1);
  const result = readRequestWindow(db, { now: NOW, filters: { provider: "openai" } });
  assert.equal(result.available, true);
  assert.equal(result.comparison.available, true);
  assert.equal(result.stats.overall.totalRequests, 1);
});

test("invalid optional output is omitted without disabling known counters", t => {
  const { db, add } = fixture(t);
  add(NOW - 1, { output: "bad" });
  const result = readRequestWindow(db, { now: NOW });
  assert.equal(result.available, true);
  assert.equal(Object.hasOwn(result.stats.overall, "totalOutputTokens"), false);
});
