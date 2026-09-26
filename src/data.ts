import { getDashboardStats, syncAllSessions, type DashboardStats } from "@oh-my-pi/omp-stats";

export interface UsageLimitJson {
  id?: string;
  label?: string;
  scope?: {
    provider?: string;
    accountId?: string;
    projectId?: string;
    orgId?: string;
    modelId?: string;
    tier?: string;
    windowId?: string;
    shared?: boolean;
    sharedGroup?: string;
  };
  window?: {
    id?: string;
    label?: string;
    durationMs?: number;
    resetsAt?: number;
    resetLabel?: string;
  };
  amount?: {
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
    unit?: string;
  };
  status?: string;
  notes?: string[];
}

export interface UsageReportJson {
  provider: string;
  fetchedAt?: number;
  limits?: UsageLimitJson[];
  notes?: string[];
  metadata?: Record<string, unknown>;
}

export interface UsagePayloadJson {
  generatedAt?: number;
  reports?: UsageReportJson[];
  accountsWithoutUsage?: Array<{
    provider: string;
    email?: string;
    accountId?: string;
    projectId?: string;
    orgId?: string;
    orgName?: string;
  }>;
  disabledCredentials?: Array<{
    provider?: string;
    email?: string;
    accountId?: string;
    reason?: string;
    [key: string]: unknown;
  }>;
  capacity?: Record<string, unknown>;
}

export interface StatsRefreshResult {
  stats?: DashboardStats;
  statsUpdatedAt?: number;
  syncedEntries?: number;
  syncedFiles?: number;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Incrementally sync session logs and read cache/request stats. */
export async function refreshStats(): Promise<StatsRefreshResult> {
  try {
    const synced = await syncAllSessions();
    const stats = await getDashboardStats();
    return {
      stats,
      statsUpdatedAt: Date.now(),
      syncedEntries: synced.processed,
      syncedFiles: synced.files,
    };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
