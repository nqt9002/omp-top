import { padRight, style, truncateAnsi, visibleWidth } from "./format.mjs";

export const WORKSPACE_MAX_WIDTH = 160;
export const WORKSPACE_MIN_WIDTH = 40;

export function workspaceGeometry(terminalWidth) {
  const physical = Math.max(WORKSPACE_MIN_WIDTH, Number(terminalWidth) || WORKSPACE_MIN_WIDTH);
  const width = Math.min(physical, WORKSPACE_MAX_WIDTH);
  const offset = Math.max(0, Math.floor((physical - width) / 2));
  const innerWidth = Math.max(1, width - 4);
  const mode = innerWidth >= 132 ? "wide" : innerWidth >= 88 ? "normal" : "compact";
  return { physical, width, offset, innerWidth, mode };
}

export function composeSides(left, right, width) {
  const available = Math.max(1, width);
  const l = String(left ?? "");
  const r = String(right ?? "");
  if (!r) return truncateAnsi(l, available);
  const rightWidth = visibleWidth(r);
  if (rightWidth >= available) return truncateAnsi(r, available);
  const leftWidth = Math.max(0, available - rightWidth - 1);
  const clippedLeft = truncateAnsi(l, leftWidth);
  const pad = Math.max(1, available - visibleWidth(clippedLeft) - rightWidth);
  return `${clippedLeft}${" ".repeat(pad)}${r}`;
}

export function frameTop(width, title = "") {
  const inner = Math.max(1, width - 2);
  const decorated = title ? ` ${title} ` : "";
  const titleText = truncateAnsi(decorated, inner);
  const rule = "─".repeat(Math.max(0, inner - visibleWidth(titleText)));
  return `╭${titleText}${rule}╮`;
}

export function frameDivider(width) {
  return `├${"─".repeat(Math.max(1, width - 2))}┤`;
}

export function frameBottom(width) {
  return `╰${"─".repeat(Math.max(1, width - 2))}╯`;
}

export function frameRow(text, width) {
  const inner = Math.max(1, width - 4);
  return `│ ${padRight(truncateAnsi(String(text ?? ""), inner), inner)} │`;
}

export function offsetLine(line, offset) {
  return `${" ".repeat(Math.max(0, offset))}${line}`;
}

export function sectionTitle(label, width, status = "") {
  const cleanWidth = Math.max(8, width);
  const left = ` ${String(label).toUpperCase()} `;
  const statusWidth = visibleWidth(status);
  const ruleWidth = Math.max(2, cleanWidth - visibleWidth(left) - (status ? statusWidth + 1 : 0));
  return `${style.bold(left)}${style.dim("─".repeat(ruleWidth))}${status ? ` ${status}` : ""}`;
}

export function joinColumns(left, right, width, { gap = 4, minWidth = 108 } = {}) {
  if (width < minWidth) return [...left, "", ...right];
  const leftWidth = Math.floor((width - gap) / 2);
  const rightWidth = width - gap - leftWidth;
  const lines = [];
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) {
    const a = padRight(truncateAnsi(left[i] ?? "", leftWidth), leftWidth);
    const b = truncateAnsi(right[i] ?? "", rightWidth);
    lines.push(`${a}${" ".repeat(gap)}${b}`.trimEnd());
  }
  return lines;
}

export function renderMetricGrid(metrics, width) {
  if (!metrics?.length) return [];
  const columns = width >= 132 ? 6 : width >= 88 ? 3 : 2;
  const gap = 2;
  const cellWidth = Math.max(10, Math.floor((width - gap * (columns - 1)) / columns));
  const lines = [];
  for (let start = 0; start < metrics.length; start += columns) {
    const batch = metrics.slice(start, start + columns);
    const labels = batch.map(item => padRight(truncateAnsi(String(item.label), cellWidth), cellWidth));
    const values = batch.map(item => padRight(truncateAnsi(String(item.value), cellWidth), cellWidth));
    lines.push(labels.join(" ".repeat(gap)).trimEnd());
    lines.push(values.join(" ".repeat(gap)).trimEnd());
    if (start + columns < metrics.length) lines.push("");
  }
  return lines;
}
