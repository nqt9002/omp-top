#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
    redact: { type: "boolean", default: false },
    profile: { type: "string" },
    "quota-timeout": { type: "string" },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`omp-top - terminal monitor for OMP stats/cache/quota\n\nUsage:\n  omp-top [--profile NAME] [--redact] [--quota-timeout MS]\n\nOptions:\n  --profile NAME       Use an OMP profile for both stats and quota\n  --redact             Mask account identities\n  --quota-timeout MS   Optional hard cap for the background quota refresh; 0 = no cap (default)\n  -h, --help           Show this help\n  -v, --version        Show omp-top version\n\nKeys:\n  r                Refresh stats; start quota refresh if one is not already running\n  ↑/↓ or j/k       Scroll\n  PgUp/PgDn        Page scroll\n  Home/End         Jump top/bottom\n  q / Esc          Exit\n  Ctrl+D / Ctrl+C  Exit\n`);
  process.exit(0);
}

if (values.version) {
  process.stdout.write("omp-top 0.3.0\n");
  process.exit(0);
}

if (values.profile?.trim()) process.env.OMP_PROFILE = values.profile.trim();
if (values["quota-timeout"]?.trim()) process.env.OMP_TOP_QUOTA_HARD_TIMEOUT_MS = values["quota-timeout"].trim();

if (!process.stdin?.isTTY || !process.stdout?.isTTY) {
  process.stderr.write("omp-top requires an interactive TTY.\n");
  process.exit(1);
}

const { runOmpTop } = await import("./top");
await runOmpTop(Boolean(values.redact));
