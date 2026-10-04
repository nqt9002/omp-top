import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { getLocale, localeLabel, setLocale, t } from "../src/i18n.mjs";
import { configPath, readPreferences, resolveLocale, writeLanguage } from "../src/preferences.mjs";
import { formatReset, stripAnsi } from "../src/format.mjs";
import { normalizeStats } from "../src/stats.mjs";
import { renderView, renderViewTabs } from "../src/views.mjs";

async function tempConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-top-i18n-"));
  return { root, env: { ...process.env, XDG_CONFIG_HOME: root, OMP_TOP_LANG: "" } };
}

test("English is the default when no preference exists", async () => {
  const { root, env } = await tempConfig();
  try {
    assert.equal(await resolveLocale({ env, home: root }), "en");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Vietnamese preference persists outside the installed release", async () => {
  const { root, env } = await tempConfig();
  try {
    const saved = await writeLanguage("vi", { env, home: root });
    assert.equal(saved.locale, "vi");
    assert.equal(saved.path, configPath(env, root));
    assert.deepEqual(await readPreferences({ env, home: root }), { language: "vi" });
    assert.equal(await resolveLocale({ env, home: root }), "vi");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("OMP_TOP_LANG overrides the persisted locale for one process", async () => {
  const { root, env } = await tempConfig();
  try {
    await writeLanguage("vi", { env, home: root });
    assert.equal(await resolveLocale({ env: { ...env, OMP_TOP_LANG: "en" }, home: root }), "en");
    assert.equal(await resolveLocale({ env: { ...env, OMP_TOP_LANG: "vi-VN" }, home: root }), "vi");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalid or malformed preference safely falls back to English", async () => {
  const { root, env } = await tempConfig();
  try {
    await fs.mkdir(path.dirname(configPath(env, root)), { recursive: true });
    await fs.writeFile(configPath(env, root), JSON.stringify({ language: "xx" }));
    assert.equal(await resolveLocale({ env, home: root }), "en");
    await fs.writeFile(configPath(env, root), "{not-json");
    assert.equal(await resolveLocale({ env, home: root }), "en");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Vietnamese catalog localizes navigation, sections and quota timing", () => {
  const previous = getLocale();
  try {
    setLocale("vi");
    assert.equal(localeLabel(), "Tiếng Việt");
    assert.match(stripAnsi(renderViewTabs(0, 120)), /Tổng quan/);
    assert.match(formatReset(Date.now() + 30 * 60 * 1000), /reset 30p/);

    const stats = normalizeStats({
      overall: { totalRequests: 12, cacheRate: 0.5, errorRate: 0, avgTtft: 1000, avgDuration: 2000, avgTokensPerSecond: 30, totalInputTokens: 1000, totalOutputTokens: 100, totalCost: 1.2 },
      byModel: [],
    });
    const screen = stripAnsi(renderView("overview", { stats, statsState: {}, quota: undefined }, 120).join("\n"));
    assert.match(screen, /CẦN CHÚ Ý/);
    assert.match(screen, /TÓM TẮT HỆ THỐNG/);
    assert.match(screen, /Chưa có dữ liệu Quota/);
  } finally {
    setLocale(previous);
  }
});

test("language CLI persists Vietnamese and later help uses it", async () => {
  const { root, env } = await tempConfig();
  try {
    const cliEnv = { ...env, HOME: root, OMP_TOP_LANG: "" };
    const setResult = spawnSync(process.execPath, ["src/main.mjs", "language", "vi"], { cwd: process.cwd(), env: cliEnv, encoding: "utf8" });
    assert.equal(setResult.status, 0, setResult.stderr);
    assert.match(setResult.stdout, /Tiếng Việt/);

    const helpResult = spawnSync(process.execPath, ["src/main.mjs", "--help"], { cwd: process.cwd(), env: cliEnv, encoding: "utf8" });
    assert.equal(helpResult.status, 0, helpResult.stderr);
    assert.match(helpResult.stdout, /Cách dùng/);
    assert.match(helpResult.stdout, /Ngôn ngữ/);

    const englishOverride = spawnSync(process.execPath, ["src/main.mjs", "--help"], { cwd: process.cwd(), env: { ...cliEnv, OMP_TOP_LANG: "en" }, encoding: "utf8" });
    assert.equal(englishOverride.status, 0, englishOverride.stderr);
    assert.match(englishOverride.stdout, /Usage/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unsupported language is rejected without changing active catalog", async () => {
  const { root, env } = await tempConfig();
  try {
    await assert.rejects(writeLanguage("fr", { env, home: root }), /Unsupported language/);
    const previous = getLocale();
    assert.throws(() => setLocale("fr"), /Unsupported language/);
    assert.equal(getLocale(), previous);
    assert.equal(t("view.overview"), previous === "vi" ? "Tổng quan" : "Overview");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
