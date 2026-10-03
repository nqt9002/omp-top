import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { versionChannel } from '../src/release-policy.mjs';
import { parseOptions, upgradeSelection, upgradeDecision } from '../src/upgrade-options.mjs';
import { resolveGithubRelease, releaseAssetNames } from '../src/self.mjs';
const item = (tag, prerelease = false, draft = false) => ({ tag_name: tag, prerelease, draft });

test('default stable and explicit beta channel', () => {
  assert.deepEqual(upgradeSelection(), { tag: undefined, channel: 'stable', explicit: false });
  assert.equal(upgradeSelection(parseOptions(['upgrade', '--channel', 'beta'])).channel, 'beta');
  assert.equal(upgradeSelection(parseOptions(['upgrade', '--tag', 'v0.6.0-beta.1'])).tag, 'v0.6.0-beta.1');
});
for (const args of [
  ['upgrade', '--channel', 'edge'], ['upgrade', '--channel'], ['upgrade', '--channel', '--tag'],
  ['upgrade', '--tag', 'v0.6.0', '--channel', 'stable'], ['upgrade', '--beta'],
  ['upgrade', '--beta', '--tag', 'v0.6.0-beta.1'], ['upgrade', '--tag', 'latest'],
  ['--profile'], ['--quota-timeout', 'NaN'], ['upgrade', '--channel', 'stable', '--channel', 'beta'],
  ['run', '--channel', 'stable'], ['install', 'upgrade'],
]) {
  test(`invalid options fail early: ${args.join(' ')}`, () => assert.throws(() => parseOptions(args)));
}
test('stable uses GitHub Latest and validates flags', async () => {
  const result = await resolveGithubRelease({}, { fetchJson: async url => { assert.ok(url.endsWith('/latest')); return item('v0.5.3'); } });
  assert.equal(result.tag_name, 'v0.5.3');
  await assert.rejects(resolveGithubRelease({}, { fetchJson: async () => item('v0.6.0-beta.1', true) }));
});
test('beta scans pages and uses numeric version order', async () => {
  const seen = [];
  const pageOne = Array.from({ length: 99 }, () => item('v0.5.3'));
  pageOne.push(item('v0.6.0-beta.9', true));
  const result = await resolveGithubRelease({ channel: 'beta' }, { fetchJson: async url => {
    seen.push(url);
    return url.endsWith('page=1') ? pageOne : [item('v0.6.0-beta.10', true), item('v0.9.0-beta.1', true, true), item('v0.7.0-rc.1', true)];
  } });
  assert.equal(seen.length, 2);
  assert.equal(result.tag_name, 'v0.6.0-beta.10');
});
test('missing beta errors instead of installing stable or drafts', async () => {
  await assert.rejects(resolveGithubRelease({ channel: 'beta' }, { fetchJson: async () => [item('v0.5.3'), item('v0.6.0-beta.1', true, true)] }), /No published beta/);
});
test('stable 404 falls back to release list, 403 does not', async () => {
  const result = await resolveGithubRelease({ channel: 'stable' }, { fetchJson: async url => {
    if (url.endsWith('/latest')) throw Object.assign(new Error('not found'), { status: 404 });
    return [item('v0.6.0-beta.1', true), item('v0.5.3')];
  } });
  assert.equal(result.tag_name, 'v0.5.3');
  await assert.rejects(resolveGithubRelease({}, { fetchJson: async () => { throw Object.assign(new Error('rate limit'), { status: 403 }); } }), /rate limit/);
});
test('exact tag keeps the existing archive layout and validates identity', async () => {
  const tag = 'v0.6.0-beta.1';
  const result = await resolveGithubRelease({ tag }, { fetchJson: async url => {
    assert.ok(url.endsWith('/tags/' + tag)); return item(tag, true);
  } });
  assert.equal(result.tag_name, tag);
  assert.equal(releaseAssetNames(tag).archive, 'omp-top-v0.6.0-beta.1.tar.gz');
  await assert.rejects(resolveGithubRelease({ tag }, { fetchJson: async () => item('v0.6.0-beta.2', true) }));
});
test('older channel versions never silently downgrade', () => {
  assert.equal(upgradeDecision('0.6.0', '0.6.0-beta.10', upgradeSelection({ channel: 'beta' })).update, false);
  assert.equal(upgradeDecision('0.6.0-beta.1', '0.5.3', upgradeSelection()).update, false);
  assert.equal(upgradeDecision('0.6.0-beta.1', '0.5.3', upgradeSelection({ channel: 'stable' })).update, true);
  assert.equal(upgradeDecision('0.6.0', '0.5.3', upgradeSelection({ tag: 'v0.5.3' })).update, true);
  assert.equal(upgradeDecision('0.5.3', '0.5.3', upgradeSelection()).update, false);
});
test('CLI --version and --help run without importing TUI/OMP credentials', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const channel = pkg.releaseChannel ?? versionChannel(pkg.version);
  for (const flag of ['--version', '--help']) {
    const result = spawnSync(process.execPath, ['src/main.mjs', flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(flag === '--version' ? `channel: ${channel}` : '--channel stable|beta'));
  }
  const bad = spawnSync(process.execPath, ['src/main.mjs', 'upgrade', '--channel', 'edge'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
