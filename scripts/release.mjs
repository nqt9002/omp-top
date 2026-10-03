import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { compareVersions, parseVersion, releaseChannel, validateReleaseInput } from '../src/release-policy.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
function github(resource) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY is required');
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${resource}`], { encoding: 'utf8' }));
}

export function validatePromotion({ candidate, version, hotfixIssue, notes, latest }) {
  if (String(notes ?? '').trim().length < 20) throw new Error('Provide test/promotion evidence (at least 20 characters)');
  if (hotfixIssue) {
    if (!/^[1-9]\d*$/.test(hotfixIssue)) throw new Error('Hotfix issue must be an issue number');
    if (candidate) throw new Error('Choose tested beta OR hotfix exception, not both');
    if (releaseChannel(latest) !== 'stable') throw new Error('A hotfix requires an existing stable release');
    const prior = parseVersion(latest.tag_name), next = parseVersion(version);
    if (next.core[0] !== prior.core[0] || next.core[1] !== prior.core[1] || BigInt(next.core[2]) !== BigInt(prior.core[2]) + 1n) throw new Error('Hotfix must be the next stable patch version');
    return;
  }
  if (releaseChannel(candidate) !== 'beta' || parseVersion(candidate.tag_name).core.join('.') !== parseVersion(version).core.join('.')) throw new Error('Stable requires a published beta of the same core version');
}

function validate() {
  const { RELEASE_CHANNEL: channel, RELEASE_TAG: tag, EXPECTED_SHA: expectedSha } = process.env;
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Dispatch the release workflow from main (source is selected by channel)');
  const branch = channel === 'beta' ? 'develop' : 'main';
  const actualSha = git('rev-parse', 'HEAD');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  validateReleaseInput({ channel, tag, version: pkg.version, branch, expectedSha, actualSha });
  git('merge-base', '--is-ancestor', expectedSha, `origin/${branch}`);
  const tags = git('tag', '--list', tag);
  if (tags) throw new Error(`Tag ${tag} already exists; never overwrite a released version`);
  // Distinguish absence from API errors: the collection must be fetched successfully.
  const releases = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`], { encoding: 'utf8' })).flat();
  if (releases.some(item => item.tag_name === tag)) throw new Error(`Release ${tag} already exists (including drafts)`);
  const sameChannel = releases.filter(item => releaseChannel(item) === channel);
  if (sameChannel.some(item => compareVersions(item.tag_name, pkg.version) >= 0)) throw new Error('Release version must advance its channel');
  const notes = String(process.env.RELEASE_NOTES ?? '').trim();
  if (notes.length < 20) throw new Error('Describe the testing/checkpoint in at least 20 characters');
  if (channel === 'stable') {
    const testedBeta = process.env.TESTED_BETA || '';
    const hotfixIssue = process.env.HOTFIX_ISSUE || '';
    const candidate = testedBeta ? github(`releases/tags/${encodeURIComponent(testedBeta)}`) : undefined;
    const latest = releases.filter(item => releaseChannel(item) === 'stable').sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    validatePromotion({ candidate, version: pkg.version, hotfixIssue, notes, latest });
    if (candidate) {
      git('merge-base', '--is-ancestor', candidate.tag_name, expectedSha);
      const changed = git('diff', '--name-only', candidate.tag_name, expectedSha, '--', 'src', 'install.sh', 'uninstall.sh', 'LICENSE');
      if (changed) throw new Error(`Runtime differs from tested beta; publish/test another beta first:\n${changed}`);
      const oldPackage = JSON.parse(git('show', `${candidate.tag_name}:package.json`));
      delete oldPackage.version;
      const newPackage = { ...pkg }; delete newPackage.version;
      if (JSON.stringify(oldPackage) !== JSON.stringify(newPackage)) throw new Error('Package metadata differs from beta beyond the version');
    } else {
      const issue = github(`issues/${hotfixIssue}`);
      if (issue.pull_request) throw new Error('Hotfix exception must reference a tracking issue, not a PR');
    }
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nsha=${actualSha}\nversion=${pkg.version}\nchannel=${channel}\n`);
  console.log(`Release validation: ${tag} from ${branch}@${actualSha}`);
}

export function packRelease({ version, sha = 'HEAD', output = 'dist' }) {
  const parsed = parseVersion(version);
  if (parsed.build) throw new Error('Release build metadata is unsupported');
  const root = `omp-top-${parsed.version}`;
  const archive = `omp-top-v${parsed.version}.tar.gz`;
  // Archive only tracked runtime files, never a workspace/node_modules or credential file.
  const tar = execFileSync('git', ['archive', '--format=tar', `--prefix=${root}/`, sha, 'src', 'package.json', 'README.md', 'LICENSE', 'install.sh', 'uninstall.sh'], { maxBuffer: 25 * 1024 * 1024 });
  const bytes = gzipSync(tar, { level: 9 });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, archive), bytes);
  fs.writeFileSync(path.join(output, `${archive}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${archive}\n`);
  return archive;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'validate') validate();
    else if (process.argv[2] === 'pack') console.log(packRelease({ version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version }));
    else throw new Error('Usage: node scripts/release.mjs validate|pack');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
