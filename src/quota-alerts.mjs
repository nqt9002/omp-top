import { quotaDisplayGroups, quotaLimitTitle } from "./quota.mjs";
import { QUOTA_AUTO_REFRESH_MS } from "./refresh-policy.mjs";

export const QUOTA_ALERT_MAX_AGE_MS = QUOTA_AUTO_REFRESH_MS;

function accountIdentity(report, limit) {
  const metadata = report.metadata ?? {};
  return metadata.accountKey || metadata.accountId || metadata.email
    || limit.scope?.accountId || metadata.projectId || metadata.orgId || "default";
}

function bucketIdentity(limit) {
  const scope = limit.scope ?? {};
  const window = scope.windowId || limit.window?.id || limit.window?.label || "";
  if (scope.sharedGroup || scope.shared === true || /\(shared\)/i.test(limit.label ?? "")) {
    return JSON.stringify(["shared", scope.sharedGroup || limit.label || "", scope.windowId || limit.window?.label || ""]);
  }
  return JSON.stringify([limit.id || limit.label || "quota", scope.model || scope.modelId || "", scope.tier || "", window]);
}

function usedFraction(limit) {
  const amount = limit.amount ?? {};
  if (Number.isFinite(amount.usedFraction)) return amount.usedFraction;
  if (Number.isFinite(amount.used) && Number.isFinite(amount.limit) && amount.limit > 0) return amount.used / amount.limit;
  if (Number.isFinite(amount.remainingFraction)) return Math.max(0, 1 - amount.remainingFraction);
  return undefined;
}

/** Local decisions only. Call evaluate while disabled to establish the visible
 * snapshot baseline. Enabling never replays that baseline; it waits for newer
 * report evidence. Disabling preserves deduplication across toggles. Bootstrap
 * history must be evaluated while disabled even when startup enables alerts;
 * restore the enabled flag only after establishing that baseline.
 */
export class QuotaAlertPolicy {
  #enabled = false;
  #entries = new Map();
  #disabledThrough = new Map();

  get enabled() { return this.#enabled; }

  setEnabled(enabled) { this.#enabled = enabled === true; }

  evaluate(payload, { now = Date.now(), providerStates } = {}) {
    const alerts = [];
    if (!Number.isFinite(now)) return alerts;
    for (const report of Array.isArray(payload?.reports) ? payload.reports : []) {
      if (!report || typeof report.provider !== "string") continue;
      const fetchedAt = report.fetchedAt;
      if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || fetchedAt > now) continue;
      const state = providerStates instanceof Map ? providerStates.get(report.provider) : providerStates?.[report.provider];
      const providerStatus = typeof state === "string" ? state : state?.status;
      for (const group of quotaDisplayGroups(report)) {
        for (const limit of group.limits) {
          if (!limit || typeof limit !== "object") continue;
          const bucket = bucketIdentity(limit);
          const key = JSON.stringify([report.provider, accountIdentity(report, limit), bucket]);
          if (!this.#enabled) {
            this.#disabledThrough.set(key, Math.max(this.#disabledThrough.get(key) ?? 0, fetchedAt));
            continue;
          }
          if (fetchedAt <= (this.#disabledThrough.get(key) ?? 0)) continue;
          if (now - fetchedAt > QUOTA_ALERT_MAX_AGE_MS || (providerStatus && providerStatus !== "fresh")) continue;
          if ([report.status, limit.status].some(status => ["stale", "refreshing", "error", "unknown"].includes(status))) continue;
          const resetAt = limit.window?.resetsAt !== undefined ? limit.window.resetsAt : limit.intelligence?.resetsAt;
          if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt <= now)) continue;
          const used = usedFraction(limit);
          // Historical intelligence has no observation timestamp. Only use its
          // forecast when the current quota supplies a live reset boundary.
          const forecastRisk = limit.intelligence?.status === "at-risk"
            && Number.isFinite(limit.window?.resetsAt) && limit.window.resetsAt > now;
          const status = limit.status === "exhausted" || used >= 1
            ? "exhausted" : forecastRisk || limit.status === "at-risk" ? "at-risk" : "ok";
          // An unknown observation cannot establish recovery.
          if (status === "ok" && !Number.isFinite(used) && ![limit.status, limit.intelligence?.status].some(value => value === "ok" || value === "watch")) continue;
          const previous = this.#entries.get(key);
          if (previous && fetchedAt <= previous.fetchedAt) continue;
          // A changed deadline is a new cycle only after the old cycle ended.
          // Small rolling corrections to a future deadline must not re-alert.
          const newCycle = previous && Number.isFinite(previous.resetAt) && fetchedAt >= previous.resetAt
            && Number.isFinite(resetAt) && resetAt > previous.resetAt;
          const rank = status === "exhausted" ? 2 : status === "at-risk" ? 1 : 0;
          const priorRank = newCycle ? 0 : previous?.rank ?? 0;
          this.#entries.set(key, { fetchedAt, resetAt, rank: rank === 0 ? 0 : Math.max(priorRank, rank) });
          if (rank > priorRank) alerts.push({ provider: report.provider, bucket, label: quotaLimitTitle(limit), status, usedFraction: used, resetAt, fetchedAt });
        }
      }
    }
    return alerts;
  }
}
