#!/usr/bin/env bun
import { installSelf, uninstallSelf, upgradeSelf, readPackageVersion } from './self.mjs';
import { parseOptions, upgradeSelection } from './upgrade-options.mjs';
import { versionChannel } from './release-policy.mjs';

function help() {
  return `omp-top - terminal monitor for OMP stats/cache/quota

Usage:
  omp-top [run] [--profile NAME] [--redact] [--quota-timeout MS]
  omp-top install
  omp-top upgrade [--channel stable|beta | --tag vX.Y.Z[-beta.N]]
  omp-top uninstall

Upgrade:
  --channel stable     Latest stable GitHub Release (default)
  --channel beta       Latest published beta.N GitHub prerelease
  --beta               Legacy alias for --channel beta
  --tag TAG            Exact published version; permits intentional rollback

Channel choice applies to this command only; beta is never a silent opt-in.
To return from a newer beta to an older stable: upgrade --channel stable.
No npm, npx or bunx is used. The installed OMP version is independent.

Monitor:
  --profile NAME       Use a named OMP profile
  --redact             Mask account identities
  --quota-timeout MS   Optional quota hard cap; 0 = none
  -v, --version        Installed version and channel
  -h, --help           Show help

Keys: 1-6/Tab/Shift+Tab switch views; left/right views; r refresh; arrows/j/k scroll; PgUp/PgDn; Home/End; q/Esc/Ctrl+C/Ctrl+D exit
`;
}

let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error.message}\n\n${help()}`); process.exit(2); }
if (options.help) { process.stdout.write(help()); process.exit(0); }
if (options.version) {
  const version = await readPackageVersion();
  process.stdout.write(`omp-top ${version}\nchannel: ${versionChannel(version)}\n`);
  process.exit(0);
}

try {
  if (options.command === 'install') {
    const installed = await installSelf();
    process.stdout.write(`Installed omp-top ${installed.version} (${versionChannel(installed.version)})\n${installed.launcherPath}\n`);
    if (!String(process.env.PATH || '').split(':').includes(installed.launcherPath.replace(/\/omp-top$/, ''))) {
      process.stdout.write('\nAdd ~/.local/bin to PATH: export PATH="$HOME/.local/bin:$PATH"\n');
    }
    process.exit(0);
  }
  if (options.command === 'uninstall') {
    const result = await uninstallSelf();
    process.stdout.write(`Removed omp-top from ${result.installDir}\n`);
    process.exit(0);
  }
  if (options.command === 'upgrade') {
    const selection = upgradeSelection(options);
    process.stdout.write(`Checking GitHub Releases (${selection.tag || selection.channel})…\n`);
    await upgradeSelf(options);
    process.exit(0);
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }

if (options.profile?.trim()) process.env.OMP_PROFILE = options.profile.trim();
if (options.quotaTimeout !== undefined) process.env.OMP_TOP_QUOTA_HARD_TIMEOUT_MS = options.quotaTimeout;
if (!process.stdin?.isTTY || !process.stdout?.isTTY) {
  process.stderr.write('omp-top monitor requires an interactive TTY.\n'); process.exit(1);
}
const version = await readPackageVersion();
const { OmpTopApp } = await import('./top.mjs');
const app = new OmpTopApp({ redact: options.redact, version, channel: versionChannel(version) });
const cleanup = () => app.dispose();
process.once('exit', cleanup);
try { await app.run(); }
finally { process.off('exit', cleanup); app.dispose(); }
