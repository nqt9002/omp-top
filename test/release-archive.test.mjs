import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { packRelease } from '../scripts/release.mjs';

test('archive packs tracked runtime only, deterministic checksum, exact generated release manifest', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-top-release-test-'));
  const cwd = process.cwd();
  try {
    process.chdir(temp);
    const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.mkdirSync('src');
    fs.writeFileSync('src/main.mjs', "console.log('fixture');\n");
    fs.writeFileSync('package.json', JSON.stringify({ name: 'omp-top', version: '0.6.0', releaseChannel: 'beta' }) + '\n');
    for (const file of ['README.md', 'LICENSE', 'install.sh', 'uninstall.sh']) fs.writeFileSync(file, 'fixture\n');
    git('add', '.'); git('commit', '-m', 'test: fixture');
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync('DO-NOT-PUBLISH-TOKEN.txt', 'not-a-real-token');
    const name = packRelease({ version: '0.6.0-beta.1' });
    const one = fs.readFileSync(`dist/${name}`);
    packRelease({ version: '0.6.0-beta.1' });
    assert.deepEqual(fs.readFileSync(`dist/${name}`), one);
    assert.equal(fs.readFileSync(`dist/${name}.sha256`, 'utf8'), `${createHash('sha256').update(one).digest('hex')}  ${name}\n`);
    const listing = execFileSync('tar', ['-tzf', `dist/${name}`], { encoding: 'utf8' });
    assert.ok(listing.includes('omp-top-0.6.0-beta.1/src/main.mjs'));
    assert.ok(listing.includes('omp-top-0.6.0-beta.1/release-manifest.json'));
    assert.ok(!listing.includes('DO-NOT-PUBLISH'));
    assert.ok(!listing.includes('.git/'));
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', `dist/${name}`, 'omp-top-0.6.0-beta.1/release-manifest.json'], { encoding: 'utf8' }));
    assert.deepEqual(manifest, { version: '0.6.0-beta.1', channel: 'beta', sourceSha });
  } finally { process.chdir(cwd); fs.rmSync(temp, { recursive: true, force: true }); }
});
