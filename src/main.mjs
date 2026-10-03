#!/usr/bin/env bun
import { installSelf, uninstallSelf, upgradeSelf, readPackageVersion } from "./self.mjs";
import { parseOptions, upgradeSelection } from "./upgrade-options.mjs";
import { versionChannel } from "./release-policy.mjs";

function help() {
  return `omp-top - zero-dependency terminal monitor for OMP stats/cache/quota

Usage:
  omp-top [run] [--profile NAME] [--redact] [--quota-timeout MS]
  omp-top install
  omp-top upgrade [--channel stable|beta | --tag vX.Y.Z[-beta.N]]
  omp-top uninstall

Commands:
  run        Open the monitor (default)
  install    Install persistent launcher under ~/.local/bin
  upgrade    Upgrade directly from GitHub Releases
  uninstall  Remove the persistent installation

Monitor options:
  --profile NAME       Use a named OMP profile
  --redact             Mask account identity fields
  --quota-timeout MS   Optional hard cap for background quota refresh; 0 = none

Upgrade options:
  --channel stable     Latest stable GitHub Release (default)
  --channel beta       Latest published beta.N GitHub prerelease
  --tag TAG            Exact published version; permits intentional rollback/recovery

Channel choice applies to this command only and is not sticky.
To return from beta to stable explicitly: omp-top upgrade --channel stable.

Keys:
  r refresh · ↑/↓/j/k scroll · PgUp/PgDn · Home/End · q/Esc/Ctrl+D/Ctrl+C exit
`;
}

let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${help()}`); process.exit(2); }

if (options.help) { process.stdout.write(help()); process.exit(0); }
if (options.version) {
  const version = await readPackageVersion();
  process.stdout.write(`omp-top ${version}\nchannel: ${versionChannel(version)}\n`);
  process.exit(0);
}

try {
  if (options.command === "install") {
    const result = await installSelf();
    process.stdout.write(`Installed omp-top ${result.version} (${versionChannel(result.version)})\n${result.launcherPath}\n`);
    if (!String(process.env.PATH || "").split(":").includes(result.launcherPath.replace(/\/omp-top$/, ""))) {
      process.stdout.write(`\nAdd ~/.local/bin to PATH if needed:\n  export PATH="$HOME/.local/bin:$PATH"\n`);
    }
    process.exit(0);
  }
  if (options.command === "uninstall") {
    const result = await uninstallSelf();
    process.stdout.write(`Removed omp-top from ${result.installDir}\n`);
    process.exit(0);
  }
  if (options.command === "upgrade") {
    const selection = upgradeSelection(options);
    process.stdout.write(`Checking GitHub Releases (${selection.tag || selection.channel})…\n`);
    await upgradeSelf(options);
    process.exit(0);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (options.profile?.trim()) process.env.OMP_PROFILE = options.profile.trim();
if (options.quotaTimeout !== undefined) process.env.OMP_TOP_QUOTA_HARD_TIMEOUT_MS = options.quotaTimeout;

if (!process.stdin?.isTTY || !process.stdout?.isTTY) {
  process.stderr.write("omp-top monitor requires an interactive TTY.\n");
  process.exit(1);
}

const { OmpTopApp } = await import("./top.mjs");
const app = new OmpTopApp({ redact: options.redact });
const cleanup = () => app.dispose();
process.once("exit", cleanup);
try { await app.run(); }
finally { process.off("exit", cleanup); app.dispose(); }
