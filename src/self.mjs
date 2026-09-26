import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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

export const DEFAULT_GITHUB_REPO = "nqt9002/omp-top";
const MAX_RELEASE_BYTES = 20 * 1024 * 1024;

export function versionFromReleaseTag(tag) {
  const value = String(tag || "").trim();
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Invalid GitHub release tag: " + (value || "(empty)"));
  }
  return value.replace(/^v/, "");
}

export function releaseAssetNames(tag) {
  const version = versionFromReleaseTag(tag);
  const archive = "omp-top-v" + version + ".tar.gz";
  return { version, archive, checksum: archive + ".sha256", root: "omp-top-" + version };
}

export function parseSha256(text) {
  const match = String(text || "").trim().match(/^([a-fA-F0-9]{64})(?:\s+[* ]?.*)?$/m);
  if (!match) throw new Error("Invalid SHA256 checksum asset");
  return match[1].toLowerCase();
}

function githubRepo() {
  return process.env.OMP_TOP_GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO;
}

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "omp-top",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.OMP_TOP_GITHUB_TOKEN?.trim();
  if (token) headers.authorization = "Bearer " + token;
  return headers;
}

async function fetchGithubJson(url) {
  const response = await fetch(url, { headers: githubHeaders(), redirect: "follow" });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json())?.message || ""; } catch {}
    throw new Error("GitHub API HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  return response.json();
}

export async function resolveGithubRelease({ tag, prerelease = false } = {}) {
  const base = "https://api.github.com/repos/" + githubRepo() + "/releases";
  if (tag) return fetchGithubJson(base + "/tags/" + encodeURIComponent(tag));
  if (prerelease) {
    const releases = await fetchGithubJson(base + "?per_page=30");
    const match = Array.isArray(releases) ? releases.find(release => release && release.prerelease && !release.draft) : undefined;
    if (!match) throw new Error("No GitHub prerelease is available");
    return match;
  }
  return fetchGithubJson(base + "/latest");
}

async function downloadAsset(asset) {
  if (!asset?.browser_download_url) throw new Error("Release asset has no download URL: " + (asset?.name || "unknown"));
  const response = await fetch(asset.browser_download_url, { headers: githubHeaders(), redirect: "follow" });
  if (!response.ok) throw new Error("Download " + asset.name + " failed with HTTP " + response.status);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RELEASE_BYTES) throw new Error("Release asset " + asset.name + " is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RELEASE_BYTES) throw new Error("Release asset " + asset.name + " is too large");
  return bytes;
}

async function runTar(args) {
  const child = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error((stderr || stdout || ("tar exited " + code)).trim());
  return stdout;
}

function archiveEntryIsSafe(entry, root) {
  const clean = entry.replace(/\/+$/, "");
  if (!clean) return true;
  if (clean.startsWith("/") || clean.includes("\0")) return false;
  const parts = clean.split("/");
  if (parts.some(part => part === "..")) return false;
  return clean === root || clean.startsWith(root + "/");
}

async function extractVerifiedRelease(archiveBytes, expectedSha, names) {
  const actualSha = createHash("sha256").update(archiveBytes).digest("hex");
  if (actualSha !== expectedSha) throw new Error("SHA256 mismatch for " + names.archive);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-top-upgrade-"));
  const archivePath = path.join(tempDir, names.archive);
  await fs.writeFile(archivePath, archiveBytes);
  const listing = (await runTar(["-tzf", archivePath])).split(/\r?\n/).filter(Boolean);
  if (!listing.length) throw new Error("Release archive is empty");
  if (!listing.every(entry => archiveEntryIsSafe(entry, names.root))) throw new Error("Release archive contains an unsafe path");
  if (!listing.some(entry => entry === names.root + "/package.json") || !listing.some(entry => entry === names.root + "/src/main.mjs")) {
    throw new Error("Release archive is missing package.json or src/main.mjs");
  }
  await runTar(["-xzf", archivePath, "-C", tempDir]);
  return { tempDir, sourceRoot: path.join(tempDir, names.root) };
}

export async function upgradeSelf({ tag, prerelease = false } = {}) {
  const release = await resolveGithubRelease({ tag, prerelease });
  if (!release || release.draft) throw new Error("GitHub returned an invalid/draft release");

  const names = releaseAssetNames(release.tag_name);
  const current = await readPackageVersion();
  if (current === names.version) {
    process.stdout.write("omp-top " + current + " is already up to date (" + release.tag_name + ").\n");
    return { updated: false, version: current, tag: release.tag_name };
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const archiveAsset = assets.find(asset => asset?.name === names.archive);
  const checksumAsset = assets.find(asset => asset?.name === names.checksum);
  if (!archiveAsset || !checksumAsset) throw new Error("Release " + release.tag_name + " is missing required archive/checksum assets");

  process.stdout.write("Downloading " + release.tag_name + " from GitHub Releases…\n");
  const [archiveBytes, checksumBytes] = await Promise.all([downloadAsset(archiveAsset), downloadAsset(checksumAsset)]);
  const expectedSha = parseSha256(new TextDecoder().decode(checksumBytes));
  const extracted = await extractVerifiedRelease(archiveBytes, expectedSha, names);

  try {
    const packagedVersion = await readPackageVersion(extracted.sourceRoot);
    if (packagedVersion !== names.version) throw new Error("Release tag/package version mismatch");
    const installed = await installSelf({ sourceRoot: extracted.sourceRoot });
    process.stdout.write("Upgraded omp-top " + current + " -> " + installed.version + " from GitHub Releases.\n");
    return { updated: true, version: installed.version, tag: release.tag_name };
  } finally {
    await fs.rm(extracted.tempDir, { recursive: true, force: true });
  }
}
