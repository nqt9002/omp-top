import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLocale } from "./i18n.mjs";

export function configDir(env = process.env, home = os.homedir()) {
  const xdg = String(env.XDG_CONFIG_HOME ?? "").trim();
  return xdg ? path.join(xdg, "omp-top") : path.join(home, ".config", "omp-top");
}

export function configPath(env = process.env, home = os.homedir()) {
  return path.join(configDir(env, home), "config.json");
}

export async function readPreferences({ env = process.env, home = os.homedir() } = {}) {
  try {
    const raw = await fs.readFile(configPath(env, home), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function resolveLocale({ env = process.env, home = os.homedir() } = {}) {
  const override = normalizeLocale(env.OMP_TOP_LANG);
  if (override) return override;
  const prefs = await readPreferences({ env, home });
  return normalizeLocale(prefs.language) ?? "en";
}

export async function writeLanguage(language, { env = process.env, home = os.homedir() } = {}) {
  const locale = normalizeLocale(language);
  if (!locale) throw new Error(`Unsupported language: ${language}. Use en or vi.`);
  const dir = configDir(env, home);
  const target = configPath(env, home);
  const prefs = await readPreferences({ env, home });
  const next = { ...prefs, language: locale };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, target);
  return { locale, path: target };
}
