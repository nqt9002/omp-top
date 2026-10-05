import assert from "node:assert/strict";
import test from "node:test";
import {
  composeSides, frameBottom, frameDivider, frameRow, frameTop, joinColumns,
  renderMetricGrid, workspaceGeometry,
} from "../src/layout.mjs";
import { stripAnsi, visibleWidth } from "../src/format.mjs";

test("workspace uses terminal width instead of a fixed centered canvas", () => {
  assert.deepEqual(workspaceGeometry(60), { physical: 60, width: 60, offset: 0, innerWidth: 56, mode: "compact" });
  assert.deepEqual(workspaceGeometry(112), { physical: 112, width: 112, offset: 0, innerWidth: 108, mode: "normal" });
  assert.deepEqual(workspaceGeometry(220), { physical: 220, width: 220, offset: 0, innerWidth: 216, mode: "wide" });
});

test("frame primitives keep stable width", () => {
  for (const line of [frameTop(80, "OMP TOP"), frameDivider(80), frameRow("hello", 80), frameBottom(80)]) {
    assert.equal(visibleWidth(line), 80);
  }
});

test("composeSides pins right metadata without overflowing", () => {
  const line = composeSides("Overview Quota Models Cache Agents Events", "stats 03:02 · quota 03:01", 80);
  assert.ok(visibleWidth(line) <= 80);
  assert.ok(stripAnsi(line).endsWith("stats 03:02 · quota 03:01"));
});

test("wide columns split while compact columns stack", () => {
  const left = ["LEFT", "A"];
  const right = ["RIGHT", "B"];
  assert.equal(joinColumns(left, right, 140).length, 2);
  assert.deepEqual(joinColumns(left, right, 70), ["LEFT", "A", "", "RIGHT", "B"]);
});

test("metric grid becomes denser as width grows", () => {
  const metrics = Array.from({ length: 6 }, (_, i) => ({ label: `M${i}`, value: `V${i}` }));
  const compact = renderMetricGrid(metrics, 60);
  const wide = renderMetricGrid(metrics, 150);
  assert.ok(compact.length > wide.length);
  assert.ok(wide.join("\n").includes("M5"));
});

test('long terminal messages preserve text without executing embedded cursor or link controls', async () => {
  const { wrapLines } = await import('../src/layout.mjs');
  const { safeTerminalText } = await import('../src/format.mjs');
  const input = 'before\x1b[2J\x1b]8;;https://example.test\x07label\x1b]8;;\x07\nafter';
  const clean = safeTerminalText(input);
  assert.doesNotMatch(clean, /\x1b\[2J|\x1b\]|\x07|\n/);
  assert.match(clean, /beforelabel.*after/);
  const lines = wrapLines([input], 12);
  assert.ok(lines.every(line => visibleWidth(line) <= 12));
  assert.ok(lines.join('').includes('after'));
});
