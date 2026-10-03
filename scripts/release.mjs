import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  compareVersions, parseVersion, releaseChannel, releaseLine, selectBetaForLine,
  nextBetaTag, validateReleaseInput, versionChannel,
} from '../src/release-policy.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
function github(resource) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY is required');
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${resource}`], { encoding: 'utf8' }));
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function sameCore(value, line) {
  try { return parseVersion(value).core.join('.') === releaseLine(line); } catch { return false; }
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

function fetchReleases() {
  return JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`], { encoding: 'utf8' })).flat();
}

function validate() {
  const { RELEASE_CHANNEL: channel, EXPECTED_SHA: expectedSha } = process.env;
  const branch = channel === 'beta' ? 'develop' : 'main';
  const actualSha = git('rev-parse', 'HEAD');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const line = releaseLine(pkg.version);
  const sourceChannel = pkg.releaseChannel ?? versionChannel(pkg.version);
  const releases = fetchReleases();
  const tags = git('tag', '--list').split(/\r?\n/).filter(Boolean);

  // Idempotency: a successful automatic rerun of the same source commit must
  // never manufacture another beta sequence.
  const sameSource = releases.find(item =>
    !item?.draft && releaseChannel(item) === channel && sameCore(item.tag_name, line) && item.target_commitish === actualSha
  );
  if (sameSource) {
    const version = parseVersion(sameSource.tag_name).version;
    writeOutputs({ tag: sameSource.tag_name, sha: actualSha, version, channel, skip: 'true' });
    console.log(`Release already exists for ${branch}@${actualSha}: ${sameSource.tag_name}; nothing to publish`);
    return;
  }

  const requestedTag = String(process.env.RELEASE_TAG ?? '').trim();
  const tag = requestedTag || (channel === 'beta' ? nextBetaTag(line, releases, tags) : `v${line}`);
  validateReleaseInput({ channel, tag, releaseLine: line, sourceChannel, branch, expectedSha, actualSha });
  git('merge-base', '--is-ancestor', expectedSha, `origin/${branch}`);

  const existingRelease = releases.find(item => item.tag_name === tag);
  if (channel === 'stable' && existingRelease && releaseChannel(existingRelease) === 'stable') {
    writeOutputs({ tag, sha: actualSha, version: line, channel, skip: 'true' });
    console.log(`Stable ${tag} is already published; nothing to publish`);
    return;
  }
  if (tags.includes(tag)) throw new Error(`Tag ${tag} already exists; never overwrite a released/reserved version`);
  if (existingRelease) throw new Error(`Release ${tag} already exists (including drafts)`);

  const sameChannel = releases.filter(item => releaseChannel(item) === channel);
  if (sameChannel.some(item => compareVersions(item.tag_name, tag) >= 0)) throw new Error('Release version must advance its channel');

  const notes = String(process.env.RELEASE_NOTES ?? '').trim();
  if (notes.length < 20) throw new Error('Describe the testing/checkpoint in at least 20 characters');

  if (channel === 'stable') {
    const hotfixIssue = process.env.HOTFIX_ISSUE || '';
    const requestedBeta = process.env.TESTED_BETA || '';
    const candidate = requestedBeta
      ? github(`releases/tags/${encodeURIComponent(requestedBeta)}`)
      : selectBetaForLine(releases, line);
    const latest = releases.filter(item => releaseChannel(item) === 'stable').sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    validatePromotion({ candidate: hotfixIssue ? undefined : candidate, version: line, hotfixIssue, notes, latest });
    if (candidate && !hotfixIssue) {
      git('merge-base', '--is-ancestor', candidate.tag_name, expectedSha);
      const changed = git('diff', '--name-only', candidate.tag_name, expectedSha, '--', 'src', 'install.sh', 'uninstall.sh', 'LICENSE');
      if (changed) throw new Error(`Runtime differs from tested beta; publish/test another beta first:\n${changed}`);
      const oldPackage = JSON.parse(git('show', `${candidate.tag_name}:package.json`));
      delete oldPackage.version; delete oldPackage.releaseChannel;
      const newPackage = { ...pkg }; delete newPackage.version; delete newPackage.releaseChannel;
      if (JSON.stringify(oldPackage) !== JSON.stringify(newPackage)) throw new Error('Package metadata differs from beta beyond release line/channel');
    } else if (hotfixIssue) {
      const issue = github(`issues/${hotfixIssue}`);
      if (issue.pull_request) throw new Error('Hotfix exception must reference a tracking issue, not a PR');
    }
  }

  const version = parseVersion(tag).version;
  writeOutputs({ tag, sha: actualSha, version, channel, skip: 'false' });
  console.log(`Release validation: ${tag} from ${branch}@${actualSha}`);
}

function writeField(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value));
  if (bytes.length > length) throw new Error('Tar field is too long');
  bytes.copy(buffer, offset);
}

function tarHeader(name, size) {
  if (Buffer.byteLength(name) > 100) throw new Error('Release manifest tar path is too long');
  const header = Buffer.alloc(512, 0);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, '0000644\0');
  writeField(header, 108, 8, '0000000\0');
  writeField(header, 116, 8, '0000000\0');
  writeField(header, 124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  writeField(header, 136, 12, '00000000000\0');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeField(header, 257, 6, 'ustar\0');
  writeField(header, 263, 2, '00');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function appendTarFile(tar, name, content) {
  let end = tar.length;
  while (end >= 512) {
    const block = tar.subarray(end - 512, end);
    if (block.some(byte => byte !== 0)) break;
    end -= 512;
  }
  const body = Buffer.from(content);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([tar.subarray(0, end), tarHeader(name, body.length), body, padding, Buffer.alloc(1024, 0)]);
}

export function packRelease({ version, sha = 'HEAD', output = 'dist' }) {
  const parsed = parseVersion(version);
  if (parsed.build) throw new Error('Release build metadata is unsupported');
  const channel = versionChannel(parsed.version);
  if (!['stable', 'beta'].includes(channel)) throw new Error('Only stable and beta release artifacts are supported');
  const sourceSha = git('rev-parse', sha);
  const root = `omp-top-${parsed.version}`;
  const archive = `omp-top-v${parsed.version}.tar.gz`;
  const baseTar = execFileSync('git', ['archive', '--format=tar', `--prefix=${root}/`, sha, 'src', 'package.json', 'README.md', 'LICENSE', 'install.sh', 'uninstall.sh'], { maxBuffer: 25 * 1024 * 1024 });
  const manifest = JSON.stringify({ version: parsed.version, channel, sourceSha }, null, 2) + '\n';
  const tar = appendTarFile(baseTar, `${root}/release-manifest.json`, manifest);
  const bytes = gzipSync(tar, { level: 9 });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, archive), bytes);
  fs.writeFileSync(path.join(output, `${archive}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${archive}\n`);
  return archive;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'validate') validate();
    else if (process.argv[2] === 'pack') {
      const version = process.env.RELEASE_VERSION || JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
      console.log(packRelease({ version }));
    } else throw new Error('Usage: node scripts/release.mjs validate|pack');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
