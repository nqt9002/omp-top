import assert from "node:assert/strict";
import test from "node:test";
import { OmpTopApp } from "../src/top.mjs";
import { Keys } from "../src/tui.mjs";
import { getLocale, setLocale, t } from "../src/i18n.mjs";
import { stripAnsi, visibleWidth, style } from "../src/format.mjs";
import { contentGeometry, joinPanels, wrapLines } from "../src/layout.mjs";
import { renderWorkspace, renderViewTabs } from "../src/views.mjs";
import { normalizeStats } from "../src/stats.mjs";

const now = 1_800_000_000_000;
const stats = normalizeStats({
  overall: { totalRequests: 300, errorRate: 0.05, cacheRate: 0.6, avgTtft: 450, avgTokensPerSecond: 42, totalCost: 12 },
  byModel: Array.from({ length: 30 }, (_, i) => ({
    provider: "openai-codex", model: `model-${String(i).padStart(2, "0")}`,
    totalRequests: 10, errorRate: 0.1, failedRequests: 1, avgTtft: 450, avgTokensPerSecond: 42,
    totalInputTokens: 10000, totalCacheReadTokens: 20000, totalCost: 0.4,
  })),
  byAgentType: [{ agentType: "worker", totalRequests: 300, totalInputTokens: 300000, totalOutputTokens: 50000 }],
});
const quota = { generatedAt: now, reports: [{
  provider: "openai-codex", fetchedAt: now, metadata: { accountId: "test-account" },
  limits: [{ id: "weekly", label: "Weekly", amount: { usedFraction: 1 }, window: { resetsAt: now + 3600000 }, intelligence: { status: "exhausted", usedFraction: 1, resetsAt: now + 3600000 } }],
}] };

async function loadedApp() {
  const app = new OmpTopApp({ ui: { rows: 24, start() {}, stop() {}, draw() {} }, deps: {
    now: () => now, fetchStats: async () => stats, loadCacheDiagnostics: async () => undefined,
    loadHistoricalQuota: async () => ({ payload: quota }),
    createQuotaRefresh: () => ({ cancel() {}, run: async (_redact, callbacks) => callbacks.onComplete(quota) }),
  } });
  await app.refresh();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return app;
}

test("every view fits EN/VI terminal sizes, including short terminals and split boundaries", async () => {
  const locale = getLocale();
  const app = await loadedApp();
  try {
    for (const lang of ["en", "vi"]) {
      setLocale(lang);
      for (const [width, height] of [[40, 8], [60, 16], [80, 24], [120, 35], [160, 45], [179, 24], [180, 23], [180, 24], [240, 60]]) {
        for (let key = 1; key <= 6; key++) {
          app.handleInput(String(key));
          const screen = app.render(width, height);
          assert.equal(screen.length, height, `${lang} ${key} ${width}x${height}`);
          assert.ok(screen.every(line => visibleWidth(line) === width), `${lang} ${key} ${width}x${height}`);
          assert.match(stripAnsi(screen[1]), /▌/);
        }
      }
    }
  } finally { app.dispose(); setLocale(locale); }
});

test("compact localized navigation retains all destinations and the active tab", () => {
  const locale = getLocale();
  try {
    for (const lang of ["en", "vi"]) {
      setLocale(lang);
      for (let active = 0; active < 6; active++) {
        const nav = stripAnsi(renderViewTabs(active, 36));
        for (let key = 1; key <= 6; key++) assert.ok(nav.includes(String(key)));
        assert.ok(nav.includes(t(`view.${["overview", "quota", "models", "cache", "agents", "events"][active]}.short`)));
      }
    }
  } finally { setLocale(locale); }
});

test("wide layout provides context while bounding table width and short terminals stack", () => {
  const geometry = contentGeometry(236, 60);
  assert.equal(geometry.mainWidth + geometry.detailWidth + 3, 236);
  assert.ok(geometry.mainWidth <= 132);
  assert.equal(contentGeometry(236, 23).split, false);
  const context = { stats, quota, now, events: [], statsState: {} };
  const wide = renderWorkspace("models", context, 236, 60).map(stripAnsi);
  assert.ok(wide.some(line => line.includes("MODEL PERFORMANCE") && line.includes("MODEL RELIABILITY")));
  const overview = renderWorkspace("overview", context, 236, 60).map(stripAnsi);
  assert.ok(overview[0].includes("ATTENTION") && overview[0].includes("SYSTEM CONTEXT"));
  assert.ok(overview.join("\n").includes("exhausted") || overview.join("\n").includes("100%"));
});

test("wrapping preserves colored messages and long identifiers in both panels", () => {
  const message = "Quota đang có vấn đề: " + "provider-model-".repeat(12) + " END";
  const lines = wrapLines([`\x1b[31m${message}\x1b[0m`], 36);
  assert.ok(lines.every(line => visibleWidth(line) <= 36));
  assert.equal(stripAnsi(lines.join("")).replace(/\s/g, ""), message.replace(/\s/g, ""));
  assert.ok(lines.every(line => line.startsWith("\x1b[31m")));
  const joined = joinPanels([style.red(message)], [message], 36, 40);
  assert.ok(joined.every(line => visibleWidth(line) <= 79));
  assert.ok(joined.at(-1).includes("END"));
});

test("tab navigation restores scroll and PageDown follows the current viewport height", async () => {
  const app = await loadedApp();
  try {
    app.handleInput("3");
    app.render(120, 24);
    app.handleInput(Keys.pageDown);
    const before = stripAnsi(app.render(120, 24).join("\n"));
    assert.match(before, /17\/\d+/);
    app.handleInput("2");
    app.render(120, 24);
    app.handleInput("3");
    assert.equal(stripAnsi(app.render(120, 24).join("\n")), before);
    app.handleInput(Keys.home.values().next().value);
    app.render(120, 16);
    app.handleInput(Keys.pageDown);
    assert.match(stripAnsi(app.render(120, 16).join("\n")), /9\/\d+/);
    app.render(240, 60);
    app.render(80, 24);
  } finally { app.dispose(); }
});

test("long quota identities and runtime errors remain readable after wrapping", () => {
  const label = "Long custom feature quota " + "very-long-model-name-".repeat(8);
  const longQuota = { reports: [{ ...quota.reports[0], limits: [{ ...quota.reports[0].limits[0], label }] }] };
  for (const width of [76, 116, 236]) {
    const lines = renderWorkspace("quota", { stats, quota: longQuota, now }, width, 35);
    const { split, mainWidth } = contentGeometry(width, 35);
    const text = lines.map(line => split ? stripAnsi(line).slice(0, mainWidth) : stripAnsi(line)).join("").replace(/\s/g, "");
    assert.ok(text.includes(label.replace(/\s/g, "")));
  }
  const message = "Failure " + "diagnostic-context-".repeat(16) + " END";
  const events = renderWorkspace("events", { events: [{ at: now, level: "error", message }] }, 76, 24);
  assert.ok(stripAnsi(events.join("")).includes(" END"));
});

test('row inspection supports selection, detail paging, resizing and returning to the prior tab', async () => {
  const previous = getLocale();
  const app = await loadedApp();
  try {
    for (const locale of ['en', 'vi']) {
      setLocale(locale);
      app.handleInput('3');
      app.handleInput('\r');
      for (const [width, height] of [[80,24], [120,35], [160,45], [240,60]]) {
        let lines = app.render(width, height);
        assert.equal(lines.length, height);
        assert.ok(lines.every(line => visibleWidth(line) === width));
        app.handleInput(Keys.home.values().next().value);
        app.render(width, height);
        app.handleInput(Keys.down);
        lines = app.render(width, height);
        assert.ok(stripAnsi(lines.join('\n')).includes('model-01'));
        assert.ok(stripAnsi(lines.join('\n')).includes(t('inspect.rows', { current: 2, total: 30 }).toUpperCase()));
        app.handleInput(Keys.pageDown);
        app.render(width, height);
        app.handleInput('2');
        app.render(width, height);
        app.handleInput('3');
        assert.ok(stripAnsi(app.render(width, height).join('\n')).includes(t('inspect.rows', { current: 2, total: 30 }).toUpperCase()));
      }
      app.handleInput(Keys.escape);
    }
  } finally { app.dispose(); setLocale(previous); }
});

test('full detail text stays reachable for long names, including after resize', async () => {
  const { renderInspection } = await import('../src/inspection.mjs');
  const title = 'model-' + 'identifier-'.repeat(70) + 'END';
  const entry = { id: 'stable-id', title, detail: [title] };
  for (const [width, height] of [[76,16], [116,27], [156,37], [236,52]]) {
    const state = { selected: 'stable-id', detailOffset: Number.MAX_SAFE_INTEGER };
    const lines = renderInspection([entry], state, width, height).map(stripAnsi);
    assert.ok(lines.join('\n').includes('END'));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.equal(state.selected, 'stable-id');
  }
});
