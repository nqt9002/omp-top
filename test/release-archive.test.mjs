import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { packRelease } from '../scripts/release.mjs';

test('archive packs tracked runtime only, deterministic checksum, correct layout', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-top-release-test-'));
  const cwd = process.cwd();
  try {
    process.chdir(temp);
    const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.mkdirSync('src');
    fs.writeFileSync('src/main.mjs', "console.log('0.6.0-beta.1');\n");
    for (const file of ['package.json', 'README.md', 'LICENSE', 'install.sh', 'uninstall.sh']) fs.writeFileSync(file, 'fixture\n');
    git('add', '.'); git('commit', '-m', 'test: fixture');
    fs.writeFileSync('DO-NOT-PUBLISH-TOKEN.txt', 'not-a-real-token');
    const name = packRelease({ version: '0.6.0-beta.1' });
    const one = fs.readFileSync(`dist/${name}`);
    packRelease({ version: '0.6.0-beta.1' });
    assert.deepEqual(fs.readFileSync(`dist/${name}`), one);
    assert.equal(fs.readFileSync(`dist/${name}.sha256`, 'utf8'), `${createHash('sha256').update(one).digest('hex')}  ${name}\n`);
    const listing = execFileSync('tar', ['-tzf', `dist/${name}`], { encoding: 'utf8' });
    assert.ok(listing.includes('omp-top-0.6.0-beta.1/src/main.mjs'));
    assert.ok(!listing.includes('DO-NOT-PUBLISH'));
    assert.ok(!listing.includes('.git/'));
  } finally { process.chdir(cwd); fs.rmSync(temp, { recursive: true, force: true }); }
});
