import { getIntlLocale, t } from "./i18n.mjs";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

export const colorEnabled = process.env.NO_COLOR === undefined;
function ansi(code, text) { return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text; }
export const style = {
  bold: text => ansi("1", text),
  dim: text => ansi("2", text),
  red: text => ansi("31", text),
  green: text => ansi("32", text),
  yellow: text => ansi("33", text),
  cyan: text => ansi("36", text),
  inverse: text => ansi("7", text),
};

export function stripAnsi(text) { return text.replace(ANSI_RE, ""); }
export function visibleWidth(text) {
  const plain = stripAnsi(text);
  if (globalThis.Bun?.stringWidth) return Bun.stringWidth(plain);
  return [...plain].length;
}
export function truncateAnsi(text, width) {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const plain = stripAnsi(text);
  const chars = [...plain];
  if (chars.length <= width) return plain;
  return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}
export function padRight(text, width) {
  const w = visibleWidth(text);
  return w >= width ? truncateAnsi(text, width) : text + " ".repeat(width - w);
}
export function compactNumber(value) {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 10e9 ? 1 : 2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 10e6 ? 1 : 2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 10e3 ? 1 : 2)}K`;
  return Math.round(value).toLocaleString(getIntlLocale());
}
export function percent(fraction) {
  if (!Number.isFinite(fraction)) return "-";
  const value = fraction * 100;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
}
export function formatClock(timestamp) {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString(getIntlLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export function formatAge(timestamp, now = Date.now()) {
  if (!timestamp) return t("time.unknown");
  const sec = Math.max(0, Math.round((now - timestamp) / 1000));
  if (sec < 60) return t("time.seconds", { value: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.minutes", { value: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("time.hoursMinutes", { hours, minutes: "" });
  return t("time.daysHours", { days: Math.floor(hours / 24), hours: "" });
}
export function formatUntil(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return "-";
  const delta = Number(timestamp) - now;
  if (delta <= 0) return t("time.now");
  const sec = Math.ceil(delta / 1000);
  if (sec < 60) return t("time.seconds", { value: sec });
  const min = Math.ceil(sec / 60);
  if (min < 60) return t("time.minutes", { value: min });
  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  if (hours < 24) {
    return t("time.hoursMinutes", { hours, minutes: remMin ? ` ${t("time.minutes", { value: remMin })}` : "" });
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return t("time.daysHours", { days, hours: remHours ? ` ${t("time.hoursMinutes", { hours: remHours, minutes: "" })}` : "" });
}

export function formatReset(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) return "";
  let min = Math.ceil((resetsAt - now) / 60000);
  if (min <= 0) return t("time.resetNow");
  if (min < 60) return t("time.resetMinutes", { minutes: min });
  const h = Math.floor(min / 60); min %= 60;
  if (h < 24) return t("time.resetHours", { hours: h, minutes: min ? ` ${min}m` : "" });
  const d = Math.floor(h / 24); const rh = h % 24;
  return t("time.resetDays", { days: d, hours: rh ? ` ${rh}h` : "" });
}
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
export function formatMoney(value) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(1)}`;
}
export function formatHours(hours) {
  if (!Number.isFinite(hours)) return "-";
  const totalMinutes = Math.max(1, Math.round(hours * 60));
  if (totalMinutes < 60) return t("time.minutes", { value: totalMinutes });
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (wholeHours < 24) {
    return t("time.hoursMinutes", { hours: wholeHours, minutes: minutes ? ` ${t("time.minutes", { value: minutes })}` : "" });
  }
  const days = Math.floor(wholeHours / 24);
  const remHours = wholeHours % 24;
  return t("time.daysHours", { days, hours: remHours ? ` ${t("time.hoursMinutes", { hours: remHours, minutes: "" })}` : "" });
}
export function formatPercentPerHour(fraction) {
  if (!Number.isFinite(fraction)) return "-";
  return `${(fraction * 100).toFixed(fraction * 100 < 10 ? 1 : 0)}%/h`;
}
export function sparkline(values, maxPoints = 28) {
  const chars = "▁▂▃▄▅▆▇█";
  const nums = (values ?? []).map(Number).filter(Number.isFinite).slice(-maxPoints);
  if (!nums.length) return "-";
  const min = Math.min(...nums); const max = Math.max(...nums);
  if (max === min) return chars[0].repeat(nums.length);
  return nums.map(value => chars[Math.max(0, Math.min(chars.length - 1, Math.round(((value - min) / (max - min)) * (chars.length - 1))))]).join("");
}
export function providerLabel(provider) {
  const known = {
    "openai-codex": "OpenAI Codex",
    anthropic: "Anthropic",
    "google-antigravity": "Google Antigravity",
    "google-gemini-cli": "Google Gemini CLI",
    "github-copilot": "GitHub Copilot",
    "opencode-go": "OpenCode Go",
    cursor: "Cursor",
    devin: "Devin",
    xai: "xAI",
    "xai-oauth": "xAI",
  };
  return known[provider] ?? provider.split(/[-_]/g).filter(Boolean).map(x => x[0]?.toUpperCase() + x.slice(1)).join(" ");
}
export function usedFraction(amount = {}) {
  if (Number.isFinite(amount.usedFraction)) return amount.usedFraction;
  if (Number.isFinite(amount.used) && Number.isFinite(amount.limit) && amount.limit > 0) return amount.used / amount.limit;
  if (amount.unit === "percent" && Number.isFinite(amount.used)) return amount.used / 100;
  if (Number.isFinite(amount.remainingFraction)) return Math.max(0, 1 - amount.remainingFraction);
  return undefined;
}
export function quotaColor(fraction, text) {
  if (!Number.isFinite(fraction)) return style.dim(text);
  if (fraction >= 1) return style.red(text);
  if (fraction >= 0.8) return style.yellow(text);
  return style.green(text);
}
export function cacheColor(fraction, text) {
  if (!Number.isFinite(fraction)) return style.dim(text);
  if (fraction >= 0.8) return style.green(text);
  if (fraction >= 0.5) return style.yellow(text);
  return style.red(text);
}
export function progressBar(fraction, width = 16) {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const fill = Math.round(f * width);
  const text = `${"█".repeat(fill)}${"░".repeat(width - fill)}`;
  return quotaColor(fraction, text);
}
