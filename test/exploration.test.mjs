import assert from 'node:assert/strict';
import test from 'node:test';
import { exploreEntries, filterEntries } from '../src/exploration.mjs';
import { OmpTopApp } from '../src/top.mjs';
import { Keys } from '../src/tui.mjs';
import { stripAnsi } from '../src/format.mjs';

const stats = { overall: {}, byModel: [
  { provider: 'p', model: 'alpha', totalRequests: 20, totalInputTokens: 100 },
  { provider: 'q', model: 'beta', totalRequests: 8, totalInputTokens: 200 },
] };
const diagnostics = {
  byFolderModel: [
    { provider: 'p', model: 'alpha', folder: '/project one', requests: 20, uncachedInputTokens: 100 },
    { provider: 'q', model: 'beta', folder: '/project one', requests: 8, uncachedInputTokens: 200 },
  ],
  bySessionModel: [
    { provider: 'p', model: 'alpha', folder: '/project one', sessionFile: '/session-a', requests: 20 },
    { provider: 'p', model: 'alpha', folder: '/different project', sessionFile: '/session-b', requests: 2 },
    { provider: 'q', model: 'beta', folder: '/project one', sessionFile: '/session-q', requests: 8 },
  ],
};

test('filter queries combine terms, field names and quoted paths; scope remains exact', () => {
  const { entries } = exploreEntries('cache', { stats, cacheDiagnostics: diagnostics }, { level: 'sessions' });
  assert.deepEqual(filterEntries(entries, 'provider:p model:alpha project:"/project one" session:session-a').map(e => e.sessionFile), ['/session-a']);
  assert.equal(filterEntries(entries, 'provider:missing').length, 0);
  assert.equal(exploreEntries('cache', { stats, cacheDiagnostics: diagnostics }, { level: 'sessions', scope: { folder: '/project' } }).entries.length, 0);
});

test('model to project to session targets preserve provider/model/project identity', () => {
  const context = { stats, cacheDiagnostics: diagnostics };
  const model = exploreEntries('models', context).entries[0];
  const projects = exploreEntries(model.target.view, context, model.target).entries;
  assert.equal(projects.length, 1);
  const sessions = exploreEntries(projects[0].target.view, context, projects[0].target).entries;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionFile, '/session-a');
});

test('sort is deterministic and filtering does not mutate the source', () => {
  const context = { stats };
  assert.deepEqual(exploreEntries('models', context, { sort: 'usage' }).entries.map(e => e.model), ['beta','alpha']);
  assert.deepEqual(exploreEntries('models', context, { sort: 'requests' }).entries.map(e => e.model), ['alpha','beta']);
  assert.deepEqual(exploreEntries('models', context, { provider: 'q' }).entries.map(e => e.model), ['beta']);
  assert.equal(stats.byModel[0].model, 'alpha');
});

test('quota alert targets its exact account and bucket, not just the provider', () => {
  const now = 1_800_000_000_000;
  const limit = id => ({ id, label: id, amount: { usedFraction: 1 }, window: { resetsAt: now + 3600000 }, intelligence: { status: 'exhausted' } });
  const quota = { reports: [
    { provider:'p', metadata:{accountId:'one'}, limits:[limit('daily')] },
    { provider:'p', metadata:{accountId:'two'}, limits:[limit('weekly')] },
  ] };
  const context = { stats, quota, now };
  const alerts = exploreEntries('overview', context).entries;
  assert.ok(alerts.length);
  const target = alerts.find(e => e.alert.domain === 'quota').target;
  const selected = exploreEntries(target.view, context, target).entries.find(e => e.id === target.selected);
  assert.ok(selected);
  assert.equal(selected.limit, alerts.find(e => e.alert.domain === 'quota').alert.quota.limit);
});

test('quota identities separate project and account-key reports', () => {
  const now = 1_800_000_000_000;
  const report = (metadata, used) => ({
    provider: 'p', metadata,
    limits: [{ id: 'daily', label: 'Daily', amount: { usedFraction: used },
      window: { resetsAt: now + 3600000 }, intelligence: { status: used >= 1 ? 'exhausted' : 'ok' } }],
  });
  const quota = { reports: [
    report({ projectId: 'project-one', accountKey: 'key-one' }, 0.1),
    report({ projectId: 'project-two', accountKey: 'key-two' }, 1),
  ] };
  const context = { stats, quota, now };
  const rows = exploreEntries('quota', context).entries;
  assert.equal(new Set(rows.map(row => row.id)).size, 2);
  const alert = exploreEntries('overview', context).entries.find(entry => entry.alert?.domain === 'quota');
  const selected = exploreEntries(alert.target.view, context, alert.target).entries.find(row => row.id === alert.target.selected);
  assert.equal(selected.report.metadata.projectId, 'project-two');
  assert.equal(selected.report.metadata.accountKey, 'key-two');
});

test('merged Antigravity shared alerts target the shared bucket', () => {
  const now = 1_800_000_000_000;
  const quota = { reports: [{
    provider: 'google-antigravity', metadata: { accountId: 'account' }, limits: [
      { id: 'gemini', label: 'Gemini', amount: { usedFraction: 0.1 }, window: { resetsAt: now + 3600000 }, intelligence: { status: 'ok' } },
      ...['anthropic', 'openai'].map(provider => ({ id: provider, label: 'Claude/GPT (shared)',
        scope: { provider, sharedGroup: 'third-party' }, amount: { usedFraction: 1 },
        window: { label: 'weekly', resetsAt: now + 3600000 }, intelligence: { status: 'exhausted' } })),
    ],
  }] };
  const context = { stats, quota, now };
  const alert = exploreEntries('overview', context).entries.find(entry => entry.alert?.domain === 'quota');
  const selected = exploreEntries(alert.target.view, context, alert.target).entries.find(row => row.id === alert.target.selected);
  assert.match(selected.title, /Claude\/GPT \(shared\)/);
});

test('unnamed projects keep null scope exact when drilling into sessions', () => {
  const context = { stats, cacheDiagnostics: {
    byFolderModel: [
      { provider: 'p', model: 'alpha', folder: null, requests: 1 },
      { provider: 'p', model: 'alpha', folder: '/named', requests: 1 },
    ],
    bySessionModel: [
      { provider: 'p', model: 'alpha', folder: null, sessionFile: '/unnamed-session', requests: 1 },
      { provider: 'p', model: 'alpha', folder: '/named', sessionFile: '/named-session', requests: 1 },
    ],
  } };
  const projects = exploreEntries('cache', context, { level: 'projects', scope: { provider: 'p', model: 'alpha' } }).entries;
  const unnamed = projects.find(entry => entry.folder === null);
  const sessions = exploreEntries(unnamed.target.view, context, unnamed.target).entries;
  assert.deepEqual(sessions.map(entry => entry.sessionFile), ['/unnamed-session']);
});

test('keyboard search treats q as input, Esc cancels, Enter drills and b restores source selection', async () => {
  let app, screen = '';
  const ui = { rows: 35, start(){}, stop(){}, draw(){ if (app) screen = stripAnsi(app.render(120,35).join('\n')); } };
  app = new OmpTopApp({ ui, deps: {
    fetchStats: async () => stats, loadCacheDiagnostics: async () => diagnostics,
    loadRequestWindow: async () => ({ available:false }),
    createQuotaRefresh: () => ({cancel(){},run:async()=>{}}),
  } });
  try {
    await app.refresh();
    for(let i=0;i<12;i++) await Promise.resolve();
    app.handleInput('3'); app.handleInput('/'); app.handleInput('q');
    assert.match(screen, /\/q/);
    app.handleInput(Keys.escape);
    app.handleInput('/');
    for(const char of 'model:alpha') app.handleInput(char);
    app.handleInput('\r');
    assert.match(screen, /ROWS 1\/1/);
    app.handleInput('\r');
    assert.match(screen, /project one/);
    app.handleInput('\r');
    assert.match(screen, /session-a/);
    assert.doesNotMatch(screen, /session-b|session-q/);
    app.handleInput('b');
    assert.match(screen, /project one/);
    app.handleInput('b');
    assert.match(screen, /model:alpha/);
    assert.match(screen, /ROWS 1\/1/);
    app.handleInput('c'); app.handleInput('s'); app.handleInput('f');
    assert.match(screen, /Provider: p/);
  } finally { app.dispose(); }
});
