import { parseNoisyJson } from "./json.mjs";
import { resolveAgentDbPath, spawnUsage } from "./omp.mjs";

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_MS = 400;
const REQUIRED_COLUMNS = ["recorded_at", "provider", "account_key", "email", "account_id", "limit_id", "label", "window_label", "used_fraction", "status"];

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

export class UsageHistoryReader {
  #db;
  #hasResetsAt = false;
  #available = false;
  #dbPath;

  static async open() {
    const reader = new UsageHistoryReader();
    try {
      reader.#dbPath = await resolveAgentDbPath();
      const { Database } = await import("bun:sqlite");
      reader.#db = new Database(reader.#dbPath, { readonly: true });
      reader.#db.run("PRAGMA busy_timeout = 1000");
      const columns = reader.#db.prepare("PRAGMA table_info(usage_history)").all().map(row => String(row.name));
      reader.#available = REQUIRED_COLUMNS.every(name => columns.includes(name));
      reader.#hasResetsAt = columns.includes("resets_at");
    } catch {
      reader.close();
    }
    return reader;
  }

  get available() { return this.#available; }
  get dbPath() { return this.#dbPath; }

  readSince(sinceMs) {
    if (!this.#available || !this.#db) return [];
    const resetSelect = this.#hasResetsAt ? ", resets_at" : ", NULL AS resets_at";
    try {
      const rows = this.#db.prepare(`
        SELECT recorded_at, provider, account_key, email, account_id, limit_id, label,
               window_label, used_fraction, status${resetSelect}
        FROM usage_history
        WHERE recorded_at >= ?
        ORDER BY recorded_at ASC
      `).all(sinceMs);
      return rows.map(row => ({
        recordedAt: Number(row.recorded_at),
        provider: String(row.provider),
        accountKey: String(row.account_key),
        email: row.email == null ? null : String(row.email),
        accountId: row.account_id == null ? null : String(row.account_id),
        limitId: String(row.limit_id),
        label: String(row.label),
        windowLabel: row.window_label == null ? null : String(row.window_label),
        usedFraction: row.used_fraction == null ? null : Number(row.used_fraction),
        status: row.status == null ? null : String(row.status),
        resetsAt: row.resets_at == null ? null : Number(row.resets_at),
      }));
    } catch {
      return [];
    }
  }

  close() {
    try { this.#db?.close(); } catch {}
    this.#db = undefined;
    this.#available = false;
  }
}

function latestRows(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.provider}\0${row.accountKey}\0${row.limitId}`;
    const previous = latest.get(key);
    if (!previous || row.recordedAt >= previous.recordedAt) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.accountKey.localeCompare(b.accountKey) || a.limitId.localeCompare(b.limitId));
}

export function snapshotsToQuota(rows, redact = false) {
  const latest = latestRows(rows);
  const grouped = new Map();
  const accountOrdinals = new Map();
  let generatedAt = 0;

  for (const row of latest) {
    const key = `${row.provider}\0${row.accountKey}`;
    let group = grouped.get(key);
    if (!group) {
      const next = (accountOrdinals.get(row.provider) ?? 0) + 1;
      accountOrdinals.set(row.provider, next);
      group = { provider: row.provider, accountKey: row.accountKey, ordinal: next, rows: [] };
      grouped.set(key, group);
    }
    group.rows.push(row);
    generatedAt = Math.max(generatedAt, row.recordedAt);
  }

  const reports = [];
  for (const group of grouped.values()) {
    const fetchedAt = Math.max(...group.rows.map(row => row.recordedAt));
    const sample = group.rows.reduce((a, b) => a.recordedAt >= b.recordedAt ? a : b);
    const metadata = redact
      ? { accountId: `Account ${group.ordinal}` }
      : sample.email ? { email: sample.email } : sample.accountId ? { accountId: sample.accountId } : { accountId: sample.accountKey };
    const limits = group.rows.map(row => ({
      id: row.limitId,
      label: row.label,
      scope: { provider: row.provider, accountId: redact ? `Account ${group.ordinal}` : (row.accountId ?? row.accountKey) },
      window: {
        id: row.limitId,
        label: row.windowLabel ?? row.label,
        ...(Number.isFinite(row.resetsAt) ? { resetsAt: row.resetsAt } : {}),
      },
      amount: { ...(Number.isFinite(row.usedFraction) ? { usedFraction: row.usedFraction } : {}), unit: "percent" },
      ...(row.status ? { status: row.status } : {}),
    }));
    reports.push({ provider: group.provider, fetchedAt, metadata, limits });
  }
  return { generatedAt: generatedAt || undefined, reports };
}

function reportIdentity(report) {
  const metadata = report?.metadata ?? {};
  for (const key of ["email", "accountId", "projectId", "orgId"]) {
    const value = metadata[key];
    if (typeof value === "string" && value) return `${key}:${value}`;
  }
  const scoped = report?.limits?.find(limit => typeof limit?.scope?.accountId === "string")?.scope?.accountId;
  return typeof scoped === "string" ? `accountId:${scoped}` : "";
}

function mergeLimits(base = [], fresh = []) {
  const merged = new Map();
  for (const limit of base) merged.set(limit.id || limit.label || JSON.stringify(limit.scope ?? {}), limit);
  for (const limit of fresh) {
    const key = limit.id || limit.label || JSON.stringify(limit.scope ?? {});
    const old = merged.get(key);
    merged.set(key, old ? {
      ...old, ...limit,
      scope: { ...old.scope, ...limit.scope },
      window: (old.window || limit.window) ? { ...old.window, ...limit.window } : undefined,
      amount: { ...old.amount, ...limit.amount },
    } : limit);
  }
  return [...merged.values()];
}

/** Merge one progressive provider update while preserving richer metadata from an older full report. */
export function mergeProviderReports(payload, provider, freshReports) {
  const baseReports = payload?.reports ?? [];
  const previous = baseReports.filter(report => report.provider === provider);
  const other = baseReports.filter(report => report.provider !== provider);
  const used = new Set();
  const next = freshReports.map((fresh, freshIndex) => {
    const identity = reportIdentity(fresh);
    let match = identity ? previous.findIndex((report, index) => !used.has(index) && reportIdentity(report) === identity) : -1;
    if (match < 0 && freshIndex < previous.length && !used.has(freshIndex)) match = freshIndex;
    const old = match >= 0 ? previous[match] : undefined;
    if (match >= 0) used.add(match);
    return old ? {
      ...old, ...fresh,
      metadata: { ...old.metadata, ...fresh.metadata },
      limits: mergeLimits(old.limits, fresh.limits),
    } : fresh;
  });
  previous.forEach((report, index) => { if (!used.has(index)) next.push(report); });
  const generatedAt = Math.max(payload?.generatedAt ?? 0, ...freshReports.map(report => report.fetchedAt ?? 0));
  return { ...payload, generatedAt: generatedAt || payload?.generatedAt, reports: [...other, ...next] };
}

function fingerprint(reports) {
  return JSON.stringify(reports.map(report => ({
    provider: report.provider,
    fetchedAt: report.fetchedAt,
    metadata: report.metadata,
    limits: report.limits?.map(limit => ({ id: limit.id, amount: limit.amount, status: limit.status, window: limit.window })),
  })));
}

export async function loadHistoricalQuota(redact = false) {
  const reader = await UsageHistoryReader.open();
  try {
    if (!reader.available) return { payload: undefined, progressiveAvailable: false, dbPath: reader.dbPath };
    const payload = snapshotsToQuota(reader.readSince(Date.now() - LOOKBACK_MS), redact);
    return { payload: (payload.reports?.length ?? 0) > 0 ? payload : undefined, progressiveAvailable: true, dbPath: reader.dbPath };
  } finally {
    reader.close();
  }
}

export class ProgressiveQuotaRefresh {
  #child;
  #reader;
  #pollTimer;
  #timeoutTimer;
  #cancelled = false;
  #fingerprints = new Map();

  cancel() {
    this.#cancelled = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
    try { this.#child?.kill("SIGTERM"); } catch {}
    this.#reader?.close();
  }

  async run(redact, hooks = {}) {
    const startedAt = Date.now();
    this.#reader = await UsageHistoryReader.open();
    const poll = () => {
      if (this.#cancelled || !this.#reader?.available) return;
      const payload = snapshotsToQuota(this.#reader.readSince(startedAt - 1000), redact);
      const providers = new Set((payload.reports ?? []).map(report => report.provider));
      for (const provider of providers) {
        const reports = (payload.reports ?? []).filter(report => report.provider === provider);
        const fp = fingerprint(reports);
        if (this.#fingerprints.get(provider) === fp) continue;
        this.#fingerprints.set(provider, fp);
        hooks.onProvider?.(provider, reports, Math.max(...reports.map(report => report.fetchedAt ?? 0), Date.now()));
      }
    };

    try {
      this.#child = spawnUsage({ redact });
      if (this.#reader.available) this.#pollTimer = setInterval(poll, POLL_MS);
      const hard = Number(process.env.OMP_TOP_QUOTA_HARD_TIMEOUT_MS || 0);
      const output = Promise.all([
        new Response(this.#child.stdout).text(),
        new Response(this.#child.stderr).text(),
        this.#child.exited,
      ]);
      const timeout = Number.isFinite(hard) && hard > 0
        ? new Promise((_, reject) => {
            this.#timeoutTimer = setTimeout(() => {
              try { this.#child?.kill("SIGKILL"); } catch {}
              reject(new Error(`quota refresh exceeded hard timeout ${Math.round(hard / 1000)}s`));
            }, hard);
          })
        : null;
      const [stdout, stderr, code] = timeout ? await Promise.race([output, timeout]) : await output;
      poll();
      if (this.#cancelled) return;
      if (code !== 0) throw new Error((stderr || stdout || `omp usage exited ${code}`).trim());
      const payload = parseNoisyJson(stdout, "omp usage --json");
      hooks.onComplete?.(payload);
    } catch (error) {
      if (!this.#cancelled) hooks.onError?.(errorMessage(error));
    } finally {
      if (this.#pollTimer) clearInterval(this.#pollTimer);
      if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
      this.#reader?.close();
      this.#reader = undefined;
      this.#child = undefined;
    }
  }
}
