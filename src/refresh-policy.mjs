export const STATS_AUTO_REFRESH_MS = 60_000;
export const QUOTA_AUTO_REFRESH_MS = 5 * 60_000;
export const COUNTDOWN_REDRAW_MS = 1_000;

export function nextRefreshAt(now, intervalMs) {
  const base = Number(now);
  const interval = Number(intervalMs);
  if (!Number.isFinite(base) || !Number.isFinite(interval) || interval <= 0) return undefined;
  return base + interval;
}
