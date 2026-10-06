import { resolveStatsDbPath } from "./cache-diagnostics.mjs";
import { normalizeStats } from "./stats.mjs";

const HOUR_MS = 3_600_000;
const REQUIRED_COLUMNS = ["timestamp", "provider", "model", "agent_type", "folder", "session_file", "input_tokens", "cache_read_tokens", "cache_write_tokens"];
const TOKEN_COLUMNS = ["input_tokens", "cache_read_tokens", "cache_write_tokens"];
const FILTER_COLUMNS = { provider: "provider", model: "model", folder: "folder", sessionFile: "session_file", agentType: "agent_type" };
const COVERAGE_NOTE = "Observed local records only. The oldest record does not establish continuous ingestion or complete provider activity.";

function bounds({ hours = 24, now = Date.now() } = {}) {
  if (![1, 6, 24].includes(hours) || !Number.isFinite(now)) throw new Error("Request windows require hours 1, 6, or 24 and a finite now timestamp");
  return { hours, sinceMs: now - hours * HOUR_MS, untilMs: now };
}

function unavailable(window, reason) {
  return { ...window, available: false, reason, stats: normalizeStats(), diagnostics: undefined, comparison: { available: false, reason } };
}

function filterClause(filters = {}) {
  const clauses = [];
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!Object.hasOwn(FILTER_COLUMNS, key)) throw new Error(`Unknown request filter: ${key}`);
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`Request filter ${key} must be a string`);
    clauses.push(`${FILTER_COLUMNS[key]} = ?`);
    params.push(value);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function aggregate(row, hasOutput) {
  const requests = Number(row.requests ?? 0);
  for (const column of TOKEN_COLUMNS) {
    const total = Number(row[column] ?? 0);
    if (Number(row[`${column}_valid`] ?? 0) !== requests || !Number.isSafeInteger(total) || total < 0) {
      throw new Error(`Incomplete or invalid ${column} counters in observed records`);
    }
  }
  const result = {
    totalRequests: Number(row.requests ?? 0),
    totalInputTokens: Number(row.input_tokens ?? 0),
    totalCacheReadTokens: Number(row.cache_read_tokens ?? 0),
    totalCacheWriteTokens: Number(row.cache_write_tokens ?? 0),
  };
  const output = Number(row.output_tokens ?? 0);
  if (hasOutput && Number(row.output_tokens_valid ?? 0) === requests && Number.isSafeInteger(output) && output >= 0) result.totalOutputTokens = output;
  const input = result.totalInputTokens + result.totalCacheReadTokens;
  result.cacheRate = input > 0 ? result.totalCacheReadTokens / input : 0;
  return result;
}

function diagnostic(row) {
  return {
    requests: row.totalRequests, uncachedInputTokens: row.totalInputTokens,
    cacheReadTokens: row.totalCacheReadTokens, cacheWriteTokens: row.totalCacheWriteTokens,
    cacheRate: row.cacheRate,
  };
}

// Accepts a Bun SQLite Database or node:sqlite DatabaseSync. The caller owns it.
export function readRequestWindow(db, options = {}) {
  const window = bounds(options);
  let transaction = false;
  try {
    if (!db) return unavailable(window, "Stats database unavailable");
    const columns = new Set(db.prepare("PRAGMA table_info(messages)").all().map(row => row.name));
    const missing = REQUIRED_COLUMNS.filter(column => !columns.has(column));
    if (missing.length) return unavailable(window, `Stats messages schema missing: ${missing.join(", ")}`);
    const filter = filterClause(options.filters);
    const hasOutput = columns.has("output_tokens");
    const counters = hasOutput ? [...TOKEN_COLUMNS, "output_tokens"] : TOKEN_COLUMNS;
    const sums = ["COUNT(*) AS requests", ...counters.flatMap(column => [
      `SUM(${column}) AS ${column}`,
      `SUM(CASE WHEN typeof(${column}) IN ('integer', 'real') AND ${column} >= 0
        AND ${column} <= ${Number.MAX_SAFE_INTEGER} AND ${column} = CAST(${column} AS INTEGER)
        THEN 1 ELSE 0 END) AS ${column}_valid`,
    ])].join(", ");
    db.exec("BEGIN");
    transaction = true;
    const query = (sinceMs, untilMs, dimensions = []) => {
      const select = dimensions.map(([expression, alias]) => `${expression} AS ${alias}`);
      const group = dimensions.length ? ` GROUP BY ${dimensions.map(([, alias]) => alias).join(", ")}` : "";
      return db.prepare(`SELECT ${[...select, sums].join(", ")} FROM messages
        WHERE timestamp >= ? AND timestamp < ?${filter.sql}${group}`)
        .all(sinceMs, untilMs, ...filter.params)
        .map(row => ({ ...Object.fromEntries(dimensions.map(([, alias]) => [alias, row[alias]])), ...aggregate(row, hasOutput) }));
    };
    const dimension = (column, alias = column) => [column, alias];
    const model = [dimension("provider"), dimension("model")];
    const hour = dimension(`CAST(timestamp / ${HOUR_MS} AS INTEGER) * ${HOUR_MS}`, "timestamp");
    const current = dimensions => query(window.sinceMs, window.untilMs, dimensions);
    const overall = current()[0];
    const byModel = current(model).sort((a, b) => b.totalRequests - a.totalRequests);
    const byFolder = current([dimension("folder")]);
    const byAgentType = current([dimension("agent_type", "agentType")]);
    const timeSeries = current([hour]).map(row => ({ ...row, requests: row.totalRequests })).sort((a, b) => a.timestamp - b.timestamp);
    const modelSeries = current([hour, ...model]).map(row => ({ ...row, requests: row.totalRequests })).sort((a, b) => a.timestamp - b.timestamp);
    const attribution = dimensions => current(dimensions).map(row => ({
      ...Object.fromEntries(dimensions.map(([, alias]) => [alias, row[alias]])), ...diagnostic(row),
    })).sort((a, b) => b.uncachedInputTokens - a.uncachedInputTokens);
    const diagnostics = {
      generatedAt: window.untilMs, sinceMs: window.sinceMs, untilMs: window.untilMs, dbPath: options.dbPath,
      overall: diagnostic(overall),
      byModel: byModel.map(row => ({ provider: row.provider, model: row.model, ...diagnostic(row), uncachedShare: overall.totalInputTokens > 0 ? row.totalInputTokens / overall.totalInputTokens : 0 })),
      byAgentModel: attribution([...model, dimension("agent_type", "agentType")]),
      byFolderModel: attribution([...model, dimension("folder")]),
      bySessionModel: attribution([...model, dimension("folder"), dimension("session_file", "sessionFile")]),
      hourly: modelSeries.map(row => ({ timestamp: row.timestamp, provider: row.provider, model: row.model, ...diagnostic(row) })),
    };
    const previousSinceMs = window.sinceMs - window.hours * HOUR_MS;
    const extent = db.prepare(`SELECT MIN(timestamp) AS oldest FROM messages WHERE timestamp < ?${filter.sql}`)
      .get(window.untilMs, ...filter.params);
    const coverage = { scope: "observed-local-records", coverageVerified: false, note: COVERAGE_NOTE, oldestTimestamp: extent.oldest };
    let comparison = { available: false, reason: "Local history does not reach the start of the previous window", sinceMs: previousSinceMs, untilMs: window.sinceMs, ...coverage };
    if (extent.oldest !== null && extent.oldest <= previousSinceMs) {
      try {
        const previous = query(previousSinceMs, window.sinceMs)[0];
        const metrics = {};
        for (const name of ["totalRequests", "totalInputTokens", "totalCacheReadTokens", "totalCacheWriteTokens"]) {
          metrics[name] = { current: overall[name], previous: previous[name], delta: overall[name] - previous[name], percentChange: previous[name] > 0 ? (overall[name] - previous[name]) / previous[name] * 100 : null };
        }
        comparison = { available: true, sinceMs: previousSinceMs, untilMs: window.sinceMs, metrics, ...coverage };
      } catch (error) {
        comparison = { ...comparison, reason: `Previous window unavailable: ${error.message}` };
      }
    }
    db.exec("ROLLBACK");
    transaction = false;
    return { ...window, available: true, provenance: coverage, stats: normalizeStats({ overall, byModel, byFolder, byAgentType, timeSeries, modelSeries }), diagnostics, comparison };
  } catch (error) {
    return unavailable(window, `Request window unavailable: ${error.message}`);
  } finally {
    if (transaction) { try { db.exec("ROLLBACK"); } catch {} }
  }
}

export async function loadRequestWindow(options = {}) {
  const window = bounds(options);
  let db;
  try {
    const dbPath = await resolveStatsDbPath();
    const { Database } = await import("bun:sqlite");
    db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 1000");
    return readRequestWindow(db, { ...options, now: window.untilMs, dbPath });
  } catch (error) {
    return unavailable(window, `Request window unavailable: ${error.message}`);
  } finally {
    try { db?.close(); } catch {}
  }
}
