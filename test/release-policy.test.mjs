import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVersion, compareVersions, versionChannel, releaseChannel, selectRelease, validateReleaseInput } from '../src/release-policy.mjs';
import { validatePromotion } from '../scripts/release.mjs';

const published = (tag, prerelease = false, draft = false) => ({ tag_name: tag, prerelease, draft });
test('SemVer compares numeric beta identifiers and ignores build metadata', () => {
  assert.ok(compareVersions('0.6.0-beta.10', '0.6.0-beta.9') > 0);
  assert.ok(compareVersions('0.6.0', '0.6.0-beta.99') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.2.3+one', '1.2.3+two'), 0);
  assert.ok(compareVersions('1.2.3-alpha.2', '1.2.3-alpha.x') < 0);
});
for (const invalid of ['latest', 'v01.2.3', '1.2', '1.2.3-beta.01', '1.2.3-', '1.2.3;evil']) {
  test(`reject invalid version ${invalid}`, () => assert.throws(() => parseVersion(invalid)));
}
test('channel needs both a matching tag and GitHub prerelease flag', () => {
  assert.equal(versionChannel('0.6.0-beta.1'), 'beta');
  assert.equal(versionChannel('0.6.0-rc.1'), 'prerelease');
  assert.equal(releaseChannel(published('v0.6.0-beta.1', false)), undefined);
  assert.equal(releaseChannel(published('v0.6.0', true)), undefined);
  assert.equal(releaseChannel(published('v0.6.0', false, true)), undefined);
});
test('stable never selects a beta/draft even when it was published later', () => {
  const list = [published('v0.9.0', false, true), published('v0.8.0-beta.1', true), published('v0.5.3'), published('v0.5.4')];
  assert.equal(selectRelease(list, 'stable').tag_name, 'v0.5.4');
  assert.equal(selectRelease(list, 'beta').tag_name, 'v0.8.0-beta.1');
  assert.equal(selectRelease([published('v0.5.3')], 'beta'), undefined);
});
test('select highest SemVer, not list position or lexical beta sort', () => {
  const list = [published('v0.6.0-beta.9', true), published('v0.6.0-beta.10', true), published('v0.6.0-rc.1', true)];
  assert.equal(selectRelease(list, 'beta').tag_name, 'v0.6.0-beta.10');
  assert.throws(() => selectRelease(list, 'edge'));
});
const input = { channel: 'beta', tag: 'v0.6.0-beta.1', version: '0.6.0-beta.1', branch: 'develop', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) };
test('release checks channel, source branch, SHA and committed version', () => {
  validateReleaseInput(input);
  for (const override of [{ channel: 'stable' }, { branch: 'main' }, { actualSha: 'b'.repeat(40) }, { tag: 'v0.6.0-beta.2' }, { version: '0.6.0-beta.0', tag: 'v0.6.0-beta.0' }]) {
    assert.throws(() => validateReleaseInput({ ...input, ...override }));
  }
});
test('stable promotion requires a published beta of the same core', () => {
  const input = { candidate: published('v0.6.0-beta.2', true), version: '0.6.0', notes: 'Dogfood passed on macOS with live quota refresh.' };
  validatePromotion(input);
  assert.throws(() => validatePromotion({ ...input, candidate: undefined }));
  assert.throws(() => validatePromotion({ ...input, version: '0.7.0' }));
  assert.throws(() => validatePromotion({ ...input, notes: 'ok' }));
});
test('hotfix exception is explicit, issue-backed, next-patch only', () => {
  const input = { version: '0.5.4', hotfixIssue: '42', notes: 'Urgent upgrade crash; regression tests passed.', latest: published('v0.5.3') };
  validatePromotion(input);
  assert.throws(() => validatePromotion({ ...input, version: '0.6.0' }));
  assert.throws(() => validatePromotion({ ...input, hotfixIssue: '42;echo' }));
  assert.throws(() => validatePromotion({ ...input, candidate: published('v0.5.4-beta.1', true) }));
});
