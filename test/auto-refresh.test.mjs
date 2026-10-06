import assert from "node:assert/strict";
import test from "node:test";
import { OmpTopApp } from "../src/top.mjs";
import {
  COUNTDOWN_REDRAW_MS, QUOTA_AUTO_REFRESH_MS, STATS_AUTO_REFRESH_MS, nextRefreshAt,
} from "../src/refresh-policy.mjs";
import { setLocale } from "../src/i18n.mjs";
import { stripAnsi } from "../src/format.mjs";

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function fakeClock(start = 1_800_000_000_000) {
  let now = start;
  const timeouts = [];
  const intervals = [];
  return {
    now: () => now,
    advance(ms) { now += ms; },
    timeouts,
    intervals,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    setInterval(fn, ms) {
      const timer = { fn, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { if (timer) timer.cleared = true; },
    activeTimeout(ms) {
      return [...timeouts].reverse().find(timer => !timer.cleared && timer.ms === ms);
    },
  };
}

function makeApp(clock, counters = {}) {
  const ui = { rows: 32, start() {}, stop() {}, draw() {} };
  counters.stats ??= 0;
  counters.quota ??= 0;
  const app = new OmpTopApp({
    version: "0.6.0-beta.test",
    channel: "beta",
    ui,
    deps: {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      fetchStats: async () => {
        counters.stats++;
        return { overall: {}, byModel: [] };
      },
      loadCacheDiagnostics: async () => undefined,
      loadHistoricalQuota: async () => ({ payload: undefined }),
      createQuotaRefresh: () => ({
        cancel() {},
        run: async (_redact, callbacks) => {
          counters.quota++;
          callbacks.onComplete?.({ generatedAt: clock.now(), reports: [] });
        },
      }),
    },
  });
  return { app, ui, counters };
}

test("safe refresh policy matches local stats cadence and OMP 5-minute quota cache", () => {
  assert.equal(STATS_AUTO_REFRESH_MS, 60_000);
  assert.equal(QUOTA_AUTO_REFRESH_MS, 5 * 60_000);
  assert.equal(COUNTDOWN_REDRAW_MS, 1_000);
  assert.equal(nextRefreshAt(1000, 60_000), 61_000);
});

test("startup arms independent stats and quota auto-refresh timers", async () => {
  const clock = fakeClock();
  const { app, counters } = makeApp(clock);
  void app.run();
  await flush();

  assert.equal(counters.stats, 1);
  assert.equal(counters.quota, 1);
  assert.ok(clock.activeTimeout(STATS_AUTO_REFRESH_MS));
  assert.ok(clock.activeTimeout(QUOTA_AUTO_REFRESH_MS));
  assert.equal(clock.intervals.some(timer => timer.ms === COUNTDOWN_REDRAW_MS && !timer.cleared), true);

  app.dispose();
});

test("stats timer refreshes stats only and quota timer refreshes quota only", async () => {
  const clock = fakeClock();
  const { app, counters } = makeApp(clock);
  void app.run();
  await flush();

  const statsTimer = clock.activeTimeout(STATS_AUTO_REFRESH_MS);
  const quotaTimer = clock.activeTimeout(QUOTA_AUTO_REFRESH_MS);
  statsTimer.fn();
  await flush();
  assert.equal(counters.stats, 2);
  assert.equal(counters.quota, 1);

  quotaTimer.fn();
  await flush();
  assert.equal(counters.stats, 2);
  assert.equal(counters.quota, 2);

  app.dispose();
});

test("manual r clears old schedules and re-arms both lanes after completion", async () => {
  const clock = fakeClock();
  const { app, counters } = makeApp(clock);
  void app.run();
  await flush();

  const oldStats = clock.activeTimeout(STATS_AUTO_REFRESH_MS);
  const oldQuota = clock.activeTimeout(QUOTA_AUTO_REFRESH_MS);
  app.handleInput("r");
  await flush();

  assert.equal(oldStats.cleared, true);
  assert.equal(oldQuota.cleared, true);
  assert.equal(counters.stats, 2);
  assert.equal(counters.quota, 2);
  assert.notEqual(clock.activeTimeout(STATS_AUTO_REFRESH_MS), oldStats);
  assert.notEqual(clock.activeTimeout(QUOTA_AUTO_REFRESH_MS), oldQuota);

  app.dispose();
});

test("header uses countdown-only refresh timers in both locales", async () => {
  const previous = "en";
  const clock = fakeClock();
  const { app } = makeApp(clock);
  void app.run();
  await flush();

  clock.advance(18_000);
  setLocale("en");
  const english = stripAnsi(app.render(220, 32)[2]);
  assert.match(english, /stats ↻42s/);
  assert.match(english, /quota ↻4m 42s/);
  assert.doesNotMatch(english, /old|ago/);

  setLocale("vi");
  const vietnamese = stripAnsi(app.render(220, 32)[2]);
  assert.match(vietnamese, /stats ↻42s/);
  assert.match(vietnamese, /quota ↻4p 42s/);
  assert.doesNotMatch(vietnamese, /trước/);

  clock.advance(20_000);
  const later = stripAnsi(app.render(220, 32)[2]);
  assert.match(later, /stats ↻22s/);
  assert.match(later, /quota ↻4p 22s/);

  setLocale(previous);
  app.dispose();
});

test("dispose clears countdown and auto-refresh timers", async () => {
  const clock = fakeClock();
  const { app } = makeApp(clock);
  void app.run();
  await flush();
  app.dispose();

  assert.equal(clock.timeouts.filter(timer => !timer.cleared).length, 0);
  assert.equal(clock.intervals.filter(timer => !timer.cleared).length, 0);
});
