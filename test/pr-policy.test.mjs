import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPullRequest } from '../scripts/pr-policy.mjs';
function pr(head, base, overrides = {}) {
  return { title: 'feat: test change', body: 'Refs #11', head: { ref: head, repo: { full_name: 'nqt9002/omp-top' } }, base: { ref: base, repo: { full_name: 'nqt9002/omp-top' } }, ...overrides };
}
for (const [head, base] of [['feature/issue-11-test', 'develop'], ['fix/a', 'develop'], ['release/0.6.0', 'main'], ['hotfix/a', 'main'], ['docs/readme', 'main'], ['main', 'develop']]) {
  test(`allow ${head} -> ${base}`, () => assert.deepEqual(checkPullRequest(pr(head, base)), []));
}
for (const [head, base] of [['feature/a', 'main'], ['fix/a', 'main'], ['main', 'main'], ['random', 'develop'], ['feature/a', 'other']]) {
  test(`reject ${head} -> ${base}`, () => assert.ok(checkPullRequest(pr(head, base)).length));
}
test('require issue reference and Conventional Commit-style title', () => {
  assert.equal(checkPullRequest(pr('feature/a', 'develop', { title: 'Stuff', body: 'None' })).length, 2);
  assert.equal(checkPullRequest(undefined).length, 0);
});
