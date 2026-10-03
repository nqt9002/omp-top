import assert from "node:assert/strict";
import test from "node:test";
import {
  composeSides, frameBottom, frameDivider, frameRow, frameTop, joinColumns,
  renderMetricGrid, workspaceGeometry,
} from "../src/layout.mjs";
import { stripAnsi, visibleWidth } from "../src/format.mjs";

test("workspace expands beyond the old 112-column canvas and centers at the wide cap", () => {
  assert.deepEqual(workspaceGeometry(60), { physical: 60, width: 60, offset: 0, innerWidth: 56, mode: "compact" });
  assert.deepEqual(workspaceGeometry(112), { physical: 112, width: 112, offset: 0, innerWidth: 108, mode: "normal" });
  assert.deepEqual(workspaceGeometry(220), { physical: 220, width: 160, offset: 30, innerWidth: 156, mode: "wide" });
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
