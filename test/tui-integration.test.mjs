import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { OmpTopApp } from '../src/top.mjs';
import { TerminalUI, Keys } from '../src/tui.mjs';
import { stripAnsi } from '../src/format.mjs';
import { getLocale, setLocale } from '../src/i18n.mjs';

const stats = { overall: { totalRequests: 4 }, byModel: ['zeta', 'alpha', 'beta', 'omega'].map((model, i) => ({
  provider: i === 3 ? 'q' : 'p', model, totalRequests: 1, totalInputTokens: 10,
})) };
const diagnostics = {
  byFolderModel: [{ provider: 'p', model: 'zeta', folder: '/project-z', requests: 1, uncachedInputTokens: 10 }],
  bySessionModel: [{ provider: 'p', model: 'zeta', folder: '/project-z', sessionFile: '/session-z', requests: 1 }],
};
async function harness({ rows = 24, columns = 120, data = stats } = {}) {
  const stdin = Object.assign(new EventEmitter(), { setRawMode() {}, setEncoding() {}, resume() {}, pause() {} });
  const writes = [], queued = [];
  const stdout = Object.assign(new EventEmitter(), { rows, columns, write(text) { writes.push(text); return true; } });
  let app, fetches = 0;
  const ui = new TerminalUI({ stdin, stdout, schedule: fn => queued.push(fn),
    render: (w,h) => app.render(w,h), input: key => app.handleInput(key), paste: text => app.handlePaste(text) });
  app = new OmpTopApp({ ui, deps: {
    now: () => 1_800_000_000_000,
    fetchStats: async () => { fetches++; return data; },
    loadHistoricalQuota: async () => ({}), loadCacheDiagnostics: async () => diagnostics,
    loadRequestWindow: async () => ({ available: false }),
    createQuotaRefresh: () => ({ cancel() {}, run: async () => {} }),
  } });
  await app.refresh(); for (let i=0;i<8;i++) await Promise.resolve();
  ui.start();
  const tick = () => { while (queued.length) queued.shift()(); };
  return { app, stdin, ui, stdout, writes, tick, fetches: () => fetches,
    screen: () => stripAnsi(app.render(stdout.columns,stdout.rows).join('\n')) };
}

for (const [name, keys] of [
  ['sort then select', ['s', Keys.down]],
  ['filter then select', ['f', Keys.down]],
  ['view then select', ['2', Keys.down]],
  ['search then select', ['/', ...'beta', '\r', Keys.down]],
  ['follow model then project', ['\r', '\r']],
  ['sort, filter and clear', ['s', 'f', Keys.end.values().next().value, 'c', Keys.up]],
]) test(`batched input matches individual paints: ${name}`, async () => {
  const batch = await harness(), individual = await harness();
  try {
    for (const h of [batch, individual]) { h.stdin.emit('data','3\r'); h.tick(); }
    batch.stdin.emit('data', keys.join('')); batch.tick();
    for (const key of keys) { individual.stdin.emit('data',key); individual.tick(); }
    assert.equal(batch.screen(), individual.screen());
    if (name === 'follow model then project') assert.match(batch.screen(), /session-z/);
  } finally { batch.app.dispose(); individual.app.dispose(); }
});

test('paste is ignored on dashboard and is search data only', async () => {
  const h = await harness();
  try {
    const before = h.screen(), fetches = h.fetches();
    h.stdin.emit('data', '\x1b[200~qnrw123\x1b[201~'); h.tick();
    assert.equal(h.screen(), before);
    assert.equal(h.fetches(), fetches);
    h.stdin.emit('data','/'); h.tick();
    h.stdin.emit('data', '\x1b[200~qnr\r\n');
    h.stdin.emit('data', '\x1b[201~'); h.tick();
    assert.match(h.screen(), /Search: \/qnr  /);
    h.app.handlePaste('x'.repeat(1000)); h.tick();
    h.stdin.emit('data','\r'); h.tick();
    assert.doesNotMatch(h.screen(), /Search: \//);
  } finally { h.app.dispose(); }
});

test('search retains cancel at minimum English terminal widths', async () => {
  const locale = getLocale(); setLocale('en');
  const h = await harness();
  try {
    h.stdin.emit('data','/'); h.tick();
    for (const width of [40,41,42,60]) {
      const hint = stripAnsi(h.app.render(width,24).at(-2));
      assert.match(hint, /Esc cancel/);
      assert.match(hint, /Enter apply/);
    }
  } finally { h.app.dispose(); setLocale(locale); }
});

for (const [name, inspecting, keys] of [
  ['dashboard End then Up', false, [[...Keys.end][0], Keys.up]],
  ['detail bottom then PageUp', true, [...Array(20).fill(Keys.pageDown), Keys.pageUp]],
]) test(`batched viewport boundary reversals: ${name}`, async () => {
  const data = { ...stats, byModel: Array.from({ length: 40 }, (_,i) => ({ ...stats.byModel[0], model: `model-${i}` })) };
  const opts = { columns: 80, rows: 12, data };
  const batch = await harness(opts), individual = await harness(opts);
  try {
    for (const h of [batch,individual]) { h.stdin.emit('data','3' + (inspecting ? '\r' : '')); h.tick(); }
    batch.stdin.emit('data',keys.join('')); batch.tick();
    for (const key of keys) { individual.stdin.emit('data',key); individual.tick(); }
    assert.equal(batch.screen(),individual.screen());
  } finally { batch.app.dispose(); individual.app.dispose(); }
});

test('resize then navigation uses live viewport before the pending paint', async () => {
  const data = { ...stats, byModel: Array.from({ length: 40 }, (_,i) => ({ ...stats.byModel[0], model: `model-${i}` })) };
  const batch = await harness({ data }), individual = await harness({ data });
  try {
    for (const h of [batch,individual]) { h.stdin.emit('data','3'); h.tick(); h.stdout.rows=12;h.stdout.columns=80;h.stdout.emit('resize'); }
    individual.tick();
    for (const h of [batch,individual]) { h.stdin.emit('data',Keys.pageDown);h.tick(); }
    assert.equal(batch.screen(),individual.screen());
  } finally { batch.app.dispose(); individual.app.dispose(); }
});
