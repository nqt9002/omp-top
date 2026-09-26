import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.dirname(moduleDir);
export const defaultInstallDir = path.join(os.homedir(), ".local", "share", "omp-top");
export const defaultBinDir = path.join(os.homedir(), ".local", "bin");

export async function readPackageVersion(root = packageRoot) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    return String(pkg.version || "unknown");
  } catch { return "unknown"; }
}

async function copyIfExists(source, target, options) {
  try { await fs.cp(source, target, options); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}


async function validateSource(root) {
  if (!globalThis.Bun?.build) return;
  const srcDir = path.join(root, "src");
  const names = (await fs.readdir(srcDir)).filter(name => name.endsWith(".mjs"));
  const entrypoints = names.map(name => path.join(srcDir, name));
  const result = await Bun.build({
    entrypoints,
    target: "bun",
    write: false,
    minify: false,
  });
  if (!result.success) {
    const details = result.logs?.map(log => String(log)).join("\n") || "unknown parse/build error";
    throw new Error(`Source validation failed:\n${details}`);
  }
}

export async function installSelf({ sourceRoot = packageRoot } = {}) {
  await validateSource(sourceRoot);
  const installDir = process.env.OMP_TOP_HOME?.trim() || defaultInstallDir;
  const binDir = process.env.OMP_TOP_BIN_DIR?.trim() || defaultBinDir;
  const temp = `${installDir}.tmp-${process.pid}`;
  await fs.rm(temp, { recursive: true, force: true });
  await fs.mkdir(temp, { recursive: true });
  await fs.cp(path.join(sourceRoot, "src"), path.join(temp, "src"), { recursive: true });
  for (const file of ["package.json", "README.md", "LICENSE"]) await copyIfExists(path.join(sourceRoot, file), path.join(temp, file));
  await fs.mkdir(path.dirname(installDir), { recursive: true });
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.rename(temp, installDir);
  await fs.mkdir(binDir, { recursive: true });
  const launcher = `#!/bin/zsh\nif ! builtin pwd -P >/dev/null 2>&1; then\n  builtin cd "$HOME" || exit 1\nfi\nexec bun ${JSON.stringify(path.join(installDir, "src", "main.mjs"))} "$@"\n`;
  const launcherPath = path.join(binDir, "omp-top");
  await fs.writeFile(launcherPath, launcher, { mode: 0o755 });
  await fs.chmod(launcherPath, 0o755);
  return { installDir, launcherPath, version: await readPackageVersion(installDir) };
}

export async function uninstallSelf() {
  const installDir = process.env.OMP_TOP_HOME?.trim() || defaultInstallDir;
  const binDir = process.env.OMP_TOP_BIN_DIR?.trim() || defaultBinDir;
  await fs.rm(path.join(binDir, "omp-top"), { force: true });
  await fs.rm(installDir, { recursive: true, force: true });
  return { installDir, launcherPath: path.join(binDir, "omp-top") };
}

export async function upgradeSelf({ tag = "latest" } = {}) {
  let version;
  try {
    const response = await fetch("https://registry.npmjs.org/-/package/omp-top/dist-tags", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
    const tags = await response.json();
    version = typeof tags?.[tag] === "string" ? tags[tag] : undefined;
    if (!version) throw new Error(`npm dist-tag '${tag}' is not published`);
  } catch (error) {
    throw new Error(`Could not resolve omp-top@${tag}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const current = await readPackageVersion();
  if (current === version) {
    process.stdout.write(`omp-top ${current} is already up to date (${tag}).\n`);
    return;
  }
  const spec = `omp-top@${version}`;
  process.stdout.write(`Installing ${spec}…\n`);
  const child = Bun.spawn([process.execPath, "x", spec, "install"], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env } });
  const code = await child.exited;
  if (code !== 0) throw new Error(`bunx ${spec} install exited ${code}`);
}
