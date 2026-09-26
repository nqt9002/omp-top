export interface UsageAmountLike {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit?: string;
}

export function extractJsonPayload(text: string): string | null {
  if (!text) return null;
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  let start = -1;
  let open = "";
  let close = "";

  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
    start = objectStart;
    open = "{";
    close = "}";
  } else if (arrayStart >= 0) {
    start = arrayStart;
    open = "[";
    close = "]";
  }
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function resolveUsedFraction(amount: UsageAmountLike): number | undefined {
  if (typeof amount.usedFraction === "number") return amount.usedFraction;
  if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
    return amount.used / amount.limit;
  }
  if (amount.unit === "percent" && typeof amount.used === "number") return amount.used / 100;
  if (typeof amount.remainingFraction === "number") return Math.max(0, 1 - amount.remainingFraction);
  return undefined;
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 1 : 2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 1 : 2)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatPercent(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return "-";
  const pct = fraction * 100;
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

export function formatReset(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return "";
  const ms = resetsAt - now;
  if (ms <= 0) return "reset now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `reset ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `reset ${hours}h${remMinutes ? ` ${remMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `reset ${days}d${remHours ? ` ${remHours}h` : ""}`;
}

export function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    "openai-codex": "OpenAI Codex",
    "anthropic": "Anthropic",
    "google-antigravity": "Google Antigravity",
    "google-gemini-cli": "Google Gemini CLI",
    "github-copilot": "GitHub Copilot",
    "opencode-go": "OpenCode Go",
    "cursor": "Cursor",
    "devin": "Devin",
    "xai": "xAI",
    "xai-oauth": "xAI"
  };
  return known[provider] ?? provider.split(/[-_]/g).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

export function accountLabel(metadata: Record<string, unknown> | undefined, fallback: string): string {
  if (!metadata) return fallback;
  for (const key of ["email", "accountId", "projectId", "orgName", "orgId"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}
