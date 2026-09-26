#!/usr/bin/env bun
import { installSelf, uninstallSelf, upgradeSelf, readPackageVersion } from "./self.mjs";

function parse(argv) {
  const result = { command: "run", redact: false, profile: undefined, quotaTimeout: undefined, tag: undefined, prerelease: false, help: false, version: false };
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!commandSet && ["install", "upgrade", "uninstall", "run"].includes(arg)) { result.command = arg; commandSet = true; continue; }
    if (arg === "--redact") { result.redact = true; continue; }
    if (arg === "--profile") { result.profile = argv[++i]; continue; }
    if (arg === "--quota-timeout") { result.quotaTimeout = argv[++i]; continue; }
    if (arg === "--tag") { result.tag = argv[++i]; if (!result.tag) throw new Error("--tag requires a GitHub release tag"); continue; }
    if (arg === "--beta") { result.prerelease = true; continue; }
    if (arg === "-h" || arg === "--help") { result.help = true; continue; }
    if (arg === "-v" || arg === "--version") { result.version = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function help() {
  return `omp-top - zero-dependency terminal monitor for OMP stats/cache/quota

Usage:
  omp-top [run] [--profile NAME] [--redact] [--quota-timeout MS]
  omp-top install
  omp-top upgrade [--tag vX.Y.Z | --beta]
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
  --tag TAG            Install one exact GitHub Release tag (for example v0.5.0)
  --beta               Install the newest GitHub prerelease

Keys:
  r refresh · ↑/↓/j/k scroll · PgUp/PgDn · Home/End · q/Esc/Ctrl+D/Ctrl+C exit
`;
}

let options;
try { options = parse(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${help()}`); process.exit(2); }

if (options.help) { process.stdout.write(help()); process.exit(0); }
if (options.version) { process.stdout.write(`omp-top ${await readPackageVersion()}\n`); process.exit(0); }

if (options.command === "install") {
  const result = await installSelf();
  process.stdout.write(`Installed omp-top ${result.version}\n${result.launcherPath}\n`);
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
  process.stdout.write(`Checking GitHub Releases for an omp-top upgrade…\n`);
  try { await upgradeSelf({ tag: options.tag, prerelease: options.prerelease }); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
  process.exit(0);
}

if (options.profile?.trim()) process.env.OMP_PROFILE = options.profile.trim();
if (options.quotaTimeout?.trim()) process.env.OMP_TOP_QUOTA_HARD_TIMEOUT_MS = options.quotaTimeout.trim();

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
