import { readUsageSnapshots, type UsageSnapshotRow } from "@oh-my-pi/omp-stats/usage-windows";
import { extractJsonPayload } from "./format";
import type { UsageLimitJson, UsagePayloadJson, UsageReportJson } from "./data";

const HISTORY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const PROGRESS_POLL_MS = 400;

export type QuotaProviderStatus = "stale" | "refreshing" | "fresh" | "error";

export interface QuotaProviderState {
  status: QuotaProviderStatus;
  updatedAt?: number;
  error?: string;
}

export interface QuotaProgressHooks {
  onProvider?: (provider: string, reports: UsageReportJson[], updatedAt: number) => void;
  onComplete?: (payload: UsagePayloadJson) => void;
  onError?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hardTimeoutMs(): number {
  const raw = process.env.OMP_TOP_QUOTA_HARD_TIMEOUT_MS?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(1_000, Math.min(10 * 60_000, Math.trunc(parsed)));
}

function historyIdentity(row: UsageSnapshotRow, redact: boolean, ordinal: number): Record<string, unknown> {
  if (redact) return { accountId: `Account ${ordinal}` };
  if (row.email) return { email: row.email };
  if (row.accountId) return { accountId: row.accountId };
  return { accountId: row.accountKey };
}

function latestRows(rows: readonly UsageSnapshotRow[]): UsageSnapshotRow[] {
  const latest = new Map<string, UsageSnapshotRow>();
  for (const row of rows) {
    const key = `${row.provider}\0${row.accountKey}\0${row.limitId}`;
    const previous = latest.get(key);
    if (!previous || row.recordedAt >= previous.recordedAt) latest.set(key, row);
  }
  return [...latest.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.accountKey.localeCompare(b.accountKey) || a.limitId.localeCompare(b.limitId),
  );
}

/** Convert durable OMP usage-history rows into the quota JSON shape used by the TUI. */
export function snapshotsToQuota(rows: readonly UsageSnapshotRow[], redact: boolean): UsagePayloadJson {
  const latest = latestRows(rows);
  const accountOrdinals = new Map<string, number>();
  const providerAccountCounts = new Map<string, number>();
  const grouped = new Map<string, { provider: string; accountKey: string; rows: UsageSnapshotRow[] }>();

  for (const row of latest) {
    const key = `${row.provider}\0${row.accountKey}`;
    let group = grouped.get(key);
    if (!group) {
      group = { provider: row.provider, accountKey: row.accountKey, rows: [] };
      grouped.set(key, group);
      const next = (providerAccountCounts.get(row.provider) ?? 0) + 1;
      providerAccountCounts.det(row.provider);
      providerAccountCounts.set(row.provider, next);
      accountOrdinals.set(key, next);
    }
    group.rows.push(row);
  }

  const reports: UsageReportJson[] = [];
  let generatedAt = 0;
  for (const [key, group] of grouped) {
    const newest = Math.max(...group.rows.map(row => row.recordedAt));
    generatedAt = Math.max(generatedAt, newest);
    const sample = group.rows.reduce((a, b) => (a.recordedAt >= b.recordedAt ? a : b));
    const limits: UsageLimitJson[] = group.rows.map(row => ({
      id: row.limitId,
      label: row.label,
      scope: {
        provider: row.provider,
        accountId: redact ? `Account ${accountOrdinals.get(key) ?? 1}` : (row.accountId ?? row.accountKey),
      },
      window: row.windowLabel ? { id: row.limitId, label: row.windowLabel } : undefined,
      amount: {
        usedFraction: row.usedFraction ?? undefined,
        unit: "percent",
      },
      status: row.status ?? undefined,
    }));
    reports.push({
      provider: group.provider,
      fetchedAt: newest,
      limits,
      metadata: historyIdentity(sample, redact, accountOrdinals.get(key) ?? 1),
    });
  }

  return { generatedAt: generatedAt || undefined, reports };
}


/** Latest locally persisted quota snapshot. This never contacts a provider. */
export function loadHistoricalQuota(redact: boolean, now = Date.now()): UsagePayloadJson {
  return snapshotsToQuota(readUsageSnapshots(now - HISTORY_LOOKBACK_MS), redact);
}

function reportIdentity(report: UsageReportJson): string {
  const metadata = report.metadata ?? {};
  for (const key of ["email", "accountId", "projectId", "orgId"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value) return `${key}:${value}`;
  }
  const limitAccount = report.limits?.find(limit => typeof limit.scope?.accountId === "string")?.scope?.accountId;
  return typeof limitAccount === "string" ? `accountId:${limitAccount}` : "";
}

function mergeLimits(base: UsageLimitJson[] | undefined, fresh: UsageLimitJson[] | undefined): UsageLimitJson[] {
  const merged = new Map<string, UsageLimitJson>();
  for (const limit of base ?? []) merged.set(limit.id || limit.label || JSON.stringify(limit.scope ?? {}), limit);
  for (const limit of fresh ?? []) {
    const key = limit.id || limit.label || JSON.stringify(limit.scope ?? {});
    const previous = merged.get(key);
    merged.set(key, previous ? {
      ...previous,
      ...limit,
      scope: { ...previous.scope, ...limit.scope },
      window: previous.window || limit.window ? { ...previous.window, ...limit.window } : undefined,
      amount: { ...previous.amount, ...limit.amount },
    } : limit);
  }
  return [...merged.values()];
}

/** Merge a progressively refreshed provider without discarding richer metadata from an older live snapshot. */
export function mergeProviderReports(
  payload: UsagePayloadJson | undefined,
  provider: string,
  freshReports: readonly UsageReportJson[],
): UsagePayloadJson {
  const baseReports = payload?.reports ?? [];
  const previous = baseReports.filter(report => report.provider === provider);
  const other = baseReports.filter(report => report.provider !== provider);
  const used = new Set<number>();
  const next: UsageReportJson[] = freshReports.map((fresh, freshIndex) => {
    const identity = reportIdentity(fresh);
    let matchIndex = identity ? previous.findIndex((report, index) => !used.has(index) && reportIdentity(report) === identity) : -1;
    if (matchIndex < 0 && freshIndex < previous.length && !used.has(freshIndex)) matchIndex = freshIndex;
    const old = matchIndex >= 0 ? previous[matchIndex] : undefined;
    if (matchIndex >= 0) used.add(matchIndex);
    if (!old) return fresh;
    return {
      ...old,
      ...fresh,
      metadata: { ...old.metadata, ...fresh.metadata },
      limits: mergeLimits(old.limits, fresh.limits),
    };
  });

  // Keep unmatched old accounts visible rather than making them disappear mid-refresh.
  previous.forEach((report, index) => {
    if (!used.has(index)) next.push(report);
  });

  const newest = Math.max(payload?.generatedAt ?? 0, ...freshReports.map(report => report.fetchedAt ?? 0));
  return { ...payload, generatedAt: newest || payload?.generatedAt, reports: [...other, ...next] };
}

function providerReports(payload: UsagePayloadJson, provider: string): UsageReportJson[] {
  return (payload.reports ?? []).filter(report => report.provider === provider);
}

function fingerprint(reports: readonly UsageReportJson[]): string {
  return JSON.stringify(reports.map(report => ({
    provider: report.provider,
    fetchedAt: report.fetchedAt,
    metadata: report.metadata,
    limits: report.limits?.map(limit => ({ id: limit.id, amount: limit.amount, status: limit.status, window: limit.window })),
  })));
}

/**
 * Run one normal `omp usage --json` in the background while observing OMP's
 * durable usage_history table. UsageService records each credential report as
 * soon as it succeeds, so fast providers become visible before the aggregate
 * CLI command has finished waiting for slower providers.
 */
export class ProgressiveQuotaRefresh {
  #child: ReturnType<typeof Bun.spawn> | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  #cancelled = false;
  #lastProviderFingerprint = new Map<string, string>();

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
    try {
      this.#child?.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }

  async run(redact: boolean, hooks: QuotaProgressHooks): Promise<void> {
    const startedAt = Date.now();
    const ompBin = process.env.OMP_TOP_OMP_BIN?.trim() || "omp";
    const args = [ompBin, "usage", "--json"];
    if (redact) args.push("--redact");

    const poll = (): void => {
      if (this.#cancelled) return;
      const freshRows = readUsageSnapshots(startedAt);
      if (freshRows.length === 0) return;
      const freshPayload = snapshotsToQuota(freshRows, redact);
      const providers = new Set((freshPayload.reports ?? []).map(report => report.provider));
      for (const provider of providers) {
        const reports = providerReports(freshPayload, provider);
        const fp = fingerprint(reports);
        if (fp === this.#lastProviderFingerprint.get(provider)) continue;
        this.#lastProviderFingerprint.set(provider, fp);
        const updatedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
        hooks.onProvider?.(provider, reports, updatedAt || Date.now());
      }
    };

    try {
      this.#child = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      this.#pollTimer = setInterval(poll, PROGRESS_POLL_MS);

      const cap = hardTimeoutMs();
      const hardTimeout = cap > 0
        ? new Promise<never>((_, reject) => {
            this.#timeoutTimer = setTimeout(() => {
              try {
                this.#child?.kill("SIGKILL");
              } catch {
                // Already exited.
              }
              reject(new Error(`quota refresh exceeded hard timeout ${Math.round(cap / 1000)}s`));
            }, cap);
          })
        : undefined;

      const output = Promise.all([
        new Response(this.#child.stdout).text(),
        new Response(this.#child.stderr).text(),
        this.#child.exited,
      ]);
      const [stdout, stderr, exitCode] = hardTimeout ? await Promise.race([output, hardTimeout]) : await output;
      poll();
      if (this.#cancelled) return;
      if (exitCode !== 0) throw new Error((stderr || stdout || `omp usage exited ${exitCode}`).trim());
      const json = extractJsonPayload(stdout);
      if (!json) throw new Error("omp usage --json returned no JSON payload");
      const payload = JSON.parse(json) as UsagePayloadJson;
      if (!payload || typeof payload !== "object") throw new Error("Invalid usage payload");
      hooks.onComplete?.(payload);
    } catch (error) {
      if (!this.#cancelled) hooks.onError?.(errorMessage(error));
    } finally {
      if (this.#pollTimer) clearInterval(this.#pollTimer);
      if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
      this.#pollTimer = undefined;
      this.#timeoutTimer = undefined;
      this.#child = undefined;
    }
  }
}
