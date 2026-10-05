import { padRight, style, truncateAnsi, visibleWidth, safeTerminalText } from "./format.mjs";

export const WORKSPACE_MIN_WIDTH = 40;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SGR_PATTERN = /^\x1b\[[0-9;]*m$/u;
const SGR_SPLIT_PATTERN = /(\x1b\[[0-9;]*m)/u;
const SGR_RESET_PATTERN = /^\x1b\[(?:0)?m$/u;

export function workspaceGeometry(terminalWidth) {
  const physical = Math.max(1, Math.floor(Number(terminalWidth) || WORKSPACE_MIN_WIDTH));
  const width = physical;
  const offset = 0;
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
  return `│ ${padRight(truncateAnsi(safeTerminalText(text ?? ""), inner), inner)} │`;
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
  left = wrapLines(left, leftWidth);
  right = wrapLines(right, rightWidth);
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
  const columns = Math.min(metrics.length, width >= 132 ? 6 : width >= 88 ? 3 : 2);
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

// Bound table measure; use spare width for context instead of stretching names.
export function contentGeometry(width, height) {
  const split = width >= 176 && height >= 24;
  const mainWidth = split ? Math.min(132, Math.floor((width - 3) * 0.6)) : width;
  return { split, mainWidth, detailWidth: split ? width - mainWidth - 3 : 0 };
}

export function wrapLines(lines, width) {
  return lines.flatMap(line => wrapAnsi(String(line), width));
}

// Preserve SGR colors across wrapped words, and split long identifiers only as needed.
export function wrapAnsi(text, width) {
  text = safeTerminalText(text);
  const available = Math.max(1, width);
  if (visibleWidth(text) <= available) return [text];
  const lines = [];
  let line = "";
  let used = 0;
  let active = "";
  const indent = Math.min(text.match(/^ */u)?.[0].length ?? 0, 4, available - 1);
  const flush = () => {
    lines.push(line + (active ? "\x1b[0m" : ""));
    line = active + " ".repeat(indent);
    used = indent;
  };
  for (const word of text.split(/(\s+)/u)) {
    const size = visibleWidth(word);
    if (used && size && used + size > available) flush();
    if (lines.length && used === indent && /^\s+$/u.test(word)) continue;
    for (const part of word.split(SGR_SPLIT_PATTERN)) {
      if (SGR_PATTERN.test(part)) {
        active = SGR_RESET_PATTERN.test(part) ? "" : active + part;
        line += part;
        continue;
      }
      for (const { segment } of GRAPHEME_SEGMENTER.segment(part)) {
        const size = visibleWidth(segment);
        if (used && used + size > available) flush();
        line += segment;
        used += size;
      }
    }
  }
  if (line) lines.push(line + (active ? "\x1b[0m" : ""));
  return lines;
}

export function joinPanels(main, detail, mainWidth, detailWidth) {
  const left = wrapLines(main, mainWidth);
  const right = wrapLines(detail, detailWidth);
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
    `${padRight(left[index] ?? "", mainWidth)} ${style.dim("│")} ${right[index] ?? ""}`);
}
