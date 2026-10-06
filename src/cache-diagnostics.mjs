import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir } from "./omp.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 24 * HOUR_MS;

function n(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function cacheRate(uncached, cached) {
  const total = n(uncached) + n(cached);
  return total > 0 ? n(cached) / total : 0;
}

function normalizeAggregate(row) {
  const uncachedInputTokens = n(row?.uncached_input_tokens);
  const cacheReadTokens = n(row?.cache_read_tokens);
  return {
    requests: n(row?.requests),
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens: n(row?.cache_write_tokens),
    cacheRate: cacheRate(uncachedInputTokens, cacheReadTokens),
  };
}

export async function resolveStatsDbPath() {
  const override = process.env.OMP_TOP_STATS_DB?.trim();
  if (override) return path.resolve(override);

  const agentDir = await resolveAgentDir();
  const profile = process.env.OMP_PROFILE?.trim();
  const candidates = [path.join(path.dirname(agentDir), "stats.db")];

  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg && (process.platform === "linux" || process.platform === "darwin")) {
    candidates.unshift(profile
      ? path.join(xdg, "omp", "profiles", profile, "stats.db")
      : path.join(xdg, "omp", "stats.db"));
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return candidates[0];
}

function mapRows(rows, extra) {
  return rows.map(row => ({ ...extra(row), ...normalizeAggregate(row) }));
}

export class CacheDiagnosticsReader {
  #db;
  #available = false;
  #dbPath;

  static async open() {
    const reader = new CacheDiagnosticsReader();
    try {
      reader.#dbPath = await resolveStatsDbPath();
      const { Database } = await import("bun:sqlite");
      reader.#db = new Database(reader.#dbPath, { readonly: true });
      reader.#db.run("PRAGMA busy_timeout = 1000");
      const columns = reader.#db.prepare("PRAGMA table_info(messages)").all().map(row => String(row.name));
      const required = [
        "timestamp", "provider", "model", "agent_type", "folder", "session_file",
        "input_tokens", "cache_read_tokens", "cache_write_tokens",
      ];
      reader.#available = required.every(name => columns.includes(name));
    } catch {
      reader.close();
    }
    return reader;
  }

  get available() { return this.#available; }
  get dbPath() { return this.#dbPath; }

  read({ sinceMs = Date.now() - DEFAULT_WINDOW_MS } = {}) {
    if (!this.#available || !this.#db) return undefined;
    try {
      const totals = this.#db.prepare(`
        SELECT COUNT(*) AS requests,
               SUM(input_tokens) AS uncached_input_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens
        FROM messages WHERE timestamp >= ?
      `).get(sinceMs);
      const overall = normalizeAggregate(totals ?? {});
      const totalUncached = overall.uncachedInputTokens;

      const byModel = mapRows(this.#db.prepare(`
        SELECT provider, model, COUNT(*) AS requests,
               SUM(input_tokens) AS uncached_input_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens
        FROM messages WHERE timestamp >= ?
        GROUP BY provider, model
        ORDER BY uncached_input_tokens DESC
      `).all(sinceMs), row => ({
        provider: String(row.provider ?? "unknown"),
        model: String(row.model ?? "unknown"),
      })).map(row => ({ ...row, uncachedShare: totalUncached > 0 ? row.uncachedInputTokens / totalUncached : 0 }));

      const byAgentModel = mapRows(this.#db.prepare(`
        SELECT provider, model, agent_type, COUNT(*) AS requests,
               SUM(input_tokens) AS uncached_input_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens
        FROM messages WHERE timestamp >= ?
        GROUP BY provider, model, agent_type
        ORDER BY uncached_input_tokens DESC
      `).all(sinceMs), row => ({
        provider: String(row.provider ?? "unknown"),
        model: String(row.model ?? "unknown"),
        agentType: String(row.agent_type ?? "main"),
      }));

      const byFolderModel = mapRows(this.#db.prepare(`
        SELECT provider, model, folder, COUNT(*) AS requests,
               SUM(input_tokens) AS uncached_input_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens
        FROM messages WHERE timestamp >= ?
        GROUP BY provider, model, folder
        ORDER BY uncached_input_tokens DESC
        LIMIT 200
      `).all(sinceMs), row => ({
        provider: String(row.provider ?? "unknown"),
        model: String(row.model ?? "unknown"),
        folder: String(row.folder ?? ""),
      }));

      const bySessionModel = mapRows(this.#db.prepare(`
        SELECT provider, model, session_file, folder, COUNT(*) AS requests,
               SUM(input_tokens) AS uncached_input_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens
        FROM messages WHERE timestamp >= ?
        GROUP BY provider, model, session_file, folder
        ORDER BY uncached_input_tokens DESC
        LIMIT 300
      `).all(sinceMs), row => ({
        provider: String(row.provider ?? "unknown"),
        model: String(row.model ?? "unknown"),
        sessionFile: String(row.session_file ?? ""),
        folder: String(row.folder ?? ""),
      }));

      const hourly = mapRows(this.#db.prepare(`
        SELECT (timestamp / ?) * ? AS bucket, provider, model, COUNT(*) AS requests,
               SUM(input_tokens) AS uncached_input_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens
        FROM messages WHERE timestamp >= ?
        GROUP BY bucket, provider, model
        ORDER BY bucket ASC
      `).all(HOUR_MS, HOUR_MS, sinceMs), row => ({
        timestamp: n(row.bucket),
        provider: String(row.provider ?? "unknown"),
        model: String(row.model ?? "unknown"),
      }));

      return {
        generatedAt: Date.now(),
        sinceMs,
        dbPath: this.#dbPath,
        overall,
        byModel,
        byAgentModel,
        byFolderModel,
        bySessionModel,
        hourly,
      };
    } catch {
      return undefined;
    }
  }

  close() {
    try { this.#db?.close(); } catch {}
    this.#db = undefined;
    this.#available = false;
  }
}

export async function loadCacheDiagnostics(options) {
  const reader = await CacheDiagnosticsReader.open();
  try {
    if (!reader.available) return undefined;
    return reader.read(options);
  } finally {
    reader.close();
  }
}
