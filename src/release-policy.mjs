/** Dependency-free version/channel policy shared by the updater and release tools. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(value) {
  const version = String(value ?? '').replace(/^v/, '');
  const match = VERSION.exec(version);
  if (!match) throw new Error(`Invalid version: ${value}`);
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some(id => /^\d+$/.test(id) && id.length > 1 && id[0] === '0')) {
    throw new Error(`Invalid numeric prerelease identifier: ${value}`);
  }
  return { version, core: match.slice(1, 4), prerelease: pre, build: match[5] ?? '' };
}

function coreVersion(parsed) { return parsed.core.join('.'); }

export function releaseLine(value) {
  const parsed = parseVersion(value);
  if (parsed.prerelease.length || parsed.build) throw new Error('Release line must be a plain MAJOR.MINOR.PATCH version');
  return parsed.version;
}

export function versionChannel(value) {
  const parsed = parseVersion(value);
  if (!parsed.prerelease.length) return 'stable';
  return /^beta\.(0|[1-9]\d*)$/.test(parsed.prerelease.join('.')) ? 'beta' : 'prerelease';
}

export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  const numeric = (x, y) => BigInt(x) > BigInt(y) ? 1 : BigInt(x) < BigInt(y) ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const cmp = numeric(left.core[i], right.core[i]);
    if (cmp) return cmp;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i], y = right.prerelease[i];
    if (x === undefined || y === undefined) return Number(x !== undefined) - Number(y !== undefined);
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return numeric(x, y);
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function releaseChannel(release) {
  if (!release || release.draft || typeof release.prerelease !== 'boolean') return undefined;
  try {
    const channel = versionChannel(release.tag_name);
    if (channel === 'stable' && release.prerelease === false) return 'stable';
    if (channel === 'beta' && release.prerelease === true) return 'beta';
  } catch { /* Ignore malformed tags; never infer a channel from a title. */ }
  return undefined;
}

export function selectRelease(releases, channel) {
  if (!['stable', 'beta'].includes(channel)) throw new Error(`Unknown channel: ${channel}`);
  if (!Array.isArray(releases)) throw new Error('GitHub did not return a release list');
  return releases.filter(item => releaseChannel(item) === channel)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}

function betaSequence(value, line) {
  try {
    const parsed = parseVersion(value);
    if (coreVersion(parsed) !== releaseLine(line)) return undefined;
    if (parsed.prerelease.length !== 2 || parsed.prerelease[0] !== 'beta' || !/^[1-9]\d*$/.test(parsed.prerelease[1])) return undefined;
    return BigInt(parsed.prerelease[1]);
  } catch { return undefined; }
}

/** Compute the next published beta sequence from all known releases and tags, including drafts/orphan tags. */
export function nextBetaTag(line, releases = [], tags = []) {
  const base = releaseLine(line);
  let max = 0n;
  for (const item of releases ?? []) {
    const seq = betaSequence(item?.tag_name, base);
    if (seq !== undefined && seq > max) max = seq;
  }
  for (const tag of tags ?? []) {
    const seq = betaSequence(tag, base);
    if (seq !== undefined && seq > max) max = seq;
  }
  return `v${base}-beta.${max + 1n}`;
}

export function selectBetaForLine(releases, line) {
  const base = releaseLine(line);
  return (releases ?? [])
    .filter(item => releaseChannel(item) === 'beta')
    .filter(item => {
      try { return coreVersion(parseVersion(item.tag_name)) === base; } catch { return false; }
    })
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}

export function validateReleaseInput({ channel, tag, releaseLine: lineInput, version, sourceChannel, branch, expectedSha, actualSha }) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('Channel must be stable or beta');
  if (!/^[0-9a-f]{40}$/.test(expectedSha || '') || expectedSha !== actualSha) throw new Error('Expected SHA must match the exact checkout commit');
  const line = releaseLine(lineInput ?? version);
  if (sourceChannel !== channel) throw new Error('Source release channel does not match requested release channel');
  const parsedTag = parseVersion(tag);
  if (parsedTag.build) throw new Error('Release tags cannot contain build metadata');
  if (coreVersion(parsedTag) !== line) throw new Error('Release tag must use the configured release line');
  if (channel === 'beta') {
    if (parsedTag.prerelease.length !== 2 || parsedTag.prerelease[0] !== 'beta' || !/^[1-9]\d*$/.test(parsedTag.prerelease[1])) {
      throw new Error('Beta tag must be v<release-line>-beta.N with N >= 1');
    }
  } else if (parsedTag.prerelease.length || tag !== `v${line}`) {
    throw new Error('Stable tag must exactly match v<release-line>');
  }
  if (branch !== (channel === 'beta' ? 'develop' : 'main')) throw new Error('Wrong source branch for release channel');
  return { line, tag: parsedTag };
}
