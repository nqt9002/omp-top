import path from "node:path";
import { parseNoisyJson } from "./json.mjs";

export function ompBin() { return process.env.OMP_TOP_OMP_BIN?.trim() || "omp"; }
export function childEnv() { return { ...process.env }; }

export async function runProcess(args, { cwd, stdin = "ignore" } = {}) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin, cwd, env: childEnv() });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

export async function runOmpJson(args) {
  const result = await runProcess([ompBin(), ...args]);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `omp ${args.join(" ")} exited ${result.code}`).trim());
  return parseNoisyJson(result.stdout, `omp ${args.join(" ")}`);
}

export async function fetchStats() { return runOmpJson(["stats", "--json"]); }

export async function resolveAgentDir() {
  const result = await runProcess([ompBin(), "config", "path"]);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "omp config path failed").trim());
  const line = result.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error("omp config path returned no directory");
  return line;
}

export async function resolveAgentDbPath() { return path.join(await resolveAgentDir(), "agent.db"); }

export function spawnUsage({ redact = false } = {}) {
  const args = [ompBin(), "usage", "--json"];
  if (redact) args.push("--redact");
  return Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv() });
}
