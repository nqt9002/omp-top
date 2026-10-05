import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { TerminalUI, Keys, InputParser, parseInput } from "../src/tui.mjs";
import { truncateAnsi, visibleWidth, stripAnsi, style } from "../src/format.mjs";

function harness(lines, { rows = 8, columns = 40, input } = {}) {
  const stdin = Object.assign(new EventEmitter(), { isRaw: false, setRawMode() {}, setEncoding() {}, resume() {}, pause() {} });
  const writes = [];
  const stdout = Object.assign(new EventEmitter(), { rows, columns, write: chunk => { writes.push(String(chunk)); return true; } });
  const queued = [];
  const keys = [];
  const pastes = [];
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  let renders = 0;
  const ui = new TerminalUI({
    render: () => { renders++; return lines(); },
    input: key => { keys.push(key); input?.(key); }, paste: text => pastes.push(text),
    stdin, stdout, schedule: fn => queued.push(fn),
    setTimeout: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  const tick = () => { while (queued.length) queued.shift()(); };
  const advanceTime = ms => {
    const target = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.fn();
    }
    now = target;
  };
  return { ui, stdin, stdout, writes, keys, pastes, tick, advanceTime, timers, renders: () => renders };
}

test("coalesced escape sequences become keys, never a bare Escape", () => {
  assert.deepEqual(parseInput("\x1b[B\x1b[B\x1b[A"), [Keys.down, Keys.down, Keys.up]);
  assert.deepEqual(parseInput("\x1bOB\x1bOA"), [Keys.down, Keys.up], "application cursor mode");
  assert.deepEqual(parseInput("\x1b[1;5A\x1b[<0;10;5M\x1b[I"), [], "modified arrows, mouse and focus are dropped");
  assert.deepEqual(parseInput("\x1bx"), [], "Alt+key does not quit");
  assert.deepEqual(parseInput("\x1b"), [Keys.escape]);
  assert.deepEqual(parseInput("jk\x1b[6~q"), ["j", "k", Keys.pageDown, "q"]);
  assert.deepEqual(parseInput("\x1b[200~ab\x1bc\x1b[201~"), [], "paste is never returned as keys");
  assert.deepEqual(parseInput("\x1b[7~\x1b[8~"), ["\x1b[1~", "\x1b[4~"]);
  assert.deepEqual(parseInput("\r\n"), ["\r"]);
});

test("streaming parser preserves keys and paste at every chunk boundary", () => {
  const body = "qQ jk /?\r\n\x03\x04\x1b[A\x1b[20x café 🐈";
  const wire = "j\x1bOA\x1b[B\x1b[7~\r\n\x1b[200~" + body + "\x1b[201~\x1b[6~k";
  const expected = [
    { type: "key", key: "j" }, { type: "key", key: Keys.up },
    { type: "key", key: Keys.down }, { type: "key", key: "\x1b[1~" },
    { type: "key", key: "\r" }, { type: "paste", text: body },
    { type: "key", key: Keys.pageDown }, { type: "key", key: "k" },
  ];
  for (let split = 0; split <= wire.length; split++) {
    const parser = new InputParser();
    assert.deepEqual([...parser.feed(wire.slice(0, split)), ...parser.feed(wire.slice(split))],
      expected, `split ${split}`);
  }
  const parser = new InputParser();
  assert.deepEqual([...wire].flatMap(char => parser.feed(char)), expected, "one character per event");
});

test("isolated Escape is delayed and its timer is canceled by continuation or stop", () => {
  const h = harness(() => []);
  h.ui.start();
  h.stdin.emit("data", "\x1b");
  assert.deepEqual(h.keys, []);
  h.advanceTime(29);
  assert.deepEqual(h.keys, []);
  h.advanceTime(1);
  assert.deepEqual(h.keys, [Keys.escape]);
  assert.equal(h.timers.size, 0);

  h.stdin.emit("data", "\x1b");
  h.advanceTime(20);
  h.stdin.emit("data", "[");
  assert.equal(h.timers.size, 0, "an incomplete CSI does not get an Escape timeout");
  h.advanceTime(1000);
  h.stdin.emit("data", "B\x1bO");
  h.advanceTime(1000);
  h.stdin.emit("data", "A");
  assert.deepEqual(h.keys, [Keys.escape, Keys.down, Keys.up]);
  h.stdin.emit("data", "\x1b");
  h.ui.stop();
  assert.equal(h.timers.size, 0);
  h.advanceTime(1000);
  assert.deepEqual(h.keys, [Keys.escape, Keys.down, Keys.up]);
  h.ui.start();
  h.stdin.emit("data", "q");
  assert.equal(h.keys.at(-1), "q", "restart discards the pending Escape");
  h.ui.stop();
});

test("unsupported sequences and split mouse payloads never leak command keys", () => {
  const unsupported = [
    "\x1b[1;5A", "\x1bO1;5A", "\x1b[<0;10;5M", "\x1b[I", "\x1bx",
    "\x1b[Mqjk", "\x1b[[A", "\x1b(B", "\x1b]0;qjk\x07", "\x1b]0;qjk\x1b\\",
    "\x1bPqjk\x1b\\", "\x1b_qjk\x1b\\", "\x1b[" + "1;".repeat(200) + "q",
  ];
  for (const sequence of unsupported) {
    for (let split = 0; split <= sequence.length; split++) {
      const parser = new InputParser();
      const events = [...parser.feed(sequence.slice(0, split)),
        ...parser.feed(sequence.slice(split) + "\x1b[B")];
      assert.deepEqual(events, [{ type: "key", key: Keys.down }],
        `${JSON.stringify(sequence)} split ${split}`);
    }
  }
  const h = harness(() => []);
  h.ui.start();
  for (const char of "\x1b[Mqjk\x1b[1;5A\x1bx\x1b[B") h.stdin.emit("data", char);
  h.advanceTime(1000);
  assert.deepEqual(h.keys, [Keys.down]);
  h.ui.stop();
});

test("bracketed paste is one text callback and an incomplete paste cannot run commands", () => {
  const h = harness(() => []);
  h.ui.start();
  const body = "qjk/?\r\n\x03\x04\x1b[A\x1b[201x";
  for (const char of "\x1b[200~" + body) {
    h.stdin.emit("data", char);
    if (char !== "\x1b") h.advanceTime(100);
  }
  assert.deepEqual(h.keys, []);
  assert.deepEqual(h.pastes, []);
  h.stdin.emit("data", "\x1b[20");
  h.advanceTime(1000);
  h.stdin.emit("data", "1~\x1b[B");
  assert.deepEqual(h.pastes, [body]);
  assert.deepEqual(h.keys, [Keys.down]);
  h.stdin.emit("data", "\x1b[200~\x1b[201~");
  assert.deepEqual(h.pastes, [body, ""], "empty paste still has its own event");
  h.stdin.emit("data", "\x1b[200~unfinished q\x03");
  h.ui.stop();
  h.advanceTime(1000);
  h.ui.start();
  h.stdin.emit("data", "j");
  assert.deepEqual(h.pastes, [body, ""], "stop discards incomplete paste");
  assert.deepEqual(h.keys, [Keys.down, "j"]);
  h.ui.stop();
});

test("oversized paste retains a bounded prefix and consumes its entire payload", () => {
  const h = harness(() => []);
  const prefix = "a".repeat(64 * 1024);
  h.ui.start();
  h.stdin.emit("data", "\x1b[200~" + prefix);
  h.stdin.emit("data", "qjk\x03\x04\x1b[A".repeat(20_000));
  h.stdin.emit("data", "\x1b[20");
  h.advanceTime(1000);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(h.pastes, [], "overflow does not prematurely end paste");
  h.stdin.emit("data", "1~j\x1b[200~next\x1b[201~");
  assert.deepEqual(h.pastes, [prefix, "next"], "later pastes get a fresh bounded buffer");
  assert.deepEqual(h.keys, ["j"], "only the key after the terminator executes");
  h.ui.stop();
});

test("Ctrl+C and Ctrl+D escape interrupted control sequences but remain literal in paste", () => {
  const incomplete = [
    "\x1b", "\x1b[", "\x1b[1;", "\x1bO", "\x1bO1;", "\x1b]0;qjk",
    "\x1bPqjk", "\x1b_qjk", "\x1b(", "\x1b[[", "\x1b[Mq",
  ];
  for (const control of [Keys.ctrlC, Keys.ctrlD]) {
    for (const prefix of incomplete) {
      const parser = new InputParser();
      assert.deepEqual(parser.feed(prefix), []);
      assert.deepEqual(parser.feed(control + "j"), [
        { type: "key", key: control }, { type: "key", key: "j" },
      ], `${JSON.stringify(prefix)} canceled by ${JSON.stringify(control)}`);
      const h = harness(() => [], { input: key => { if (key === control) h.ui.stop(); } });
      h.ui.start();
      h.stdin.emit("data", prefix);
      h.stdin.emit("data", control + "q");
      h.advanceTime(1000);
      assert.deepEqual(h.keys, [control], "the exit callback can stop further command delivery");
      assert.equal(h.timers.size, 0);
    }
  }
  const parser = new InputParser();
  assert.deepEqual(parser.feed("\x1b[200~\x03\x04"), []);
  assert.deepEqual(parser.feed("\x1b[201~"), [{ type: "paste", text: "\x03\x04" }]);
});

test("a command that stops the UI prevents later events in the same chunk", () => {
  const h = harness(() => [], { input: key => { if (key === "q") h.ui.stop(); } });
  h.ui.start();
  h.stdin.emit("data", "q\x1b[200~ignored\x1b[201~jk\x1b");
  h.advanceTime(1000);
  assert.deepEqual(h.keys, ["q"]);
  assert.deepEqual(h.pastes, []);
  assert.equal(h.timers.size, 0);
});

test("draw requests coalesce into one frame and unchanged frames write nothing", () => {
  let text = "hello";
  const h = harness(() => [text, "static"]);
  h.ui.start();
  const afterStart = h.writes.length;
  for (let i = 0; i < 25; i++) h.ui.draw();
  h.tick();
  assert.equal(h.renders(), 2, "start paint + one coalesced paint");
  assert.equal(h.writes.length, afterStart, "identical frame is not rewritten");
  text = "world";
  h.ui.draw(); h.tick();
  const last = h.writes.at(-1);
  assert.match(last, /\x1b\[1;1Hworld/);
  assert.doesNotMatch(last, /static/, "only changed rows are written");
  assert.ok(last.startsWith("\x1b[?2026h") && last.endsWith("\x1b[?2026l"));
  h.ui.stop();
});

test("resize forces a full clear and repaint at the new size", () => {
  const h = harness(() => ["a", "b"]);
  h.ui.start();
  h.stdout.columns = 60;
  h.stdout.emit("resize");
  h.tick();
  const last = h.writes.at(-1);
  assert.match(last, /\x1b\[2J/);
  const rows = last.split(/\x1b\[\d+;1H/u).slice(1).map(row => row.replace(/\x1b\[\?2026l$/u, ""));
  assert.equal(rows.length, 8);
  assert.ok(rows.every(row => visibleWidth(row) === 60));
  h.ui.stop();
});

test("stdin chunks are dispatched as parsed keys; stop restores the terminal", () => {
  const h = harness(() => []);
  h.ui.start();
  h.stdin.emit("data", "\x1b[B\x1b[Bq");
  assert.deepEqual(h.keys, [Keys.down, Keys.down, "q"]);
  h.ui.draw();
  h.ui.stop();
  h.tick();
  assert.match(h.writes.at(-1), /\x1b\[\?7h\x1b\[\?25h\x1b\[\?1049l$/u);
});

test("wide terminal frames are diffed, erase shorter row tails, and restore paste mode", () => {
  for (const [columns, rows] of [[80, 24], [180, 40], [240, 60]]) {
    let line = "x".repeat(columns);
    const h = harness(() => ["unchanged", line, "also unchanged"], { rows, columns });
    h.ui.start();
    assert.match(h.writes[0], /\x1b\[\?2004h/u);
    const afterStart = h.writes.length;
    h.ui.draw(); h.tick();
    assert.equal(h.writes.length, afterStart, `${columns}×${rows}: unchanged frame writes nothing`);
    line = "short";
    h.ui.draw(); h.tick();
    assert.equal(h.writes.at(-1), `\x1b[?2026h\x1b[2;1Hshort${" ".repeat(columns - 5)}\x1b[?2026l`,
      `${columns}×${rows}: one padded row overwrites the old tail`);
    h.ui.draw();
    h.ui.stop();
    const afterStop = h.writes.length;
    const renders = h.renders();
    assert.match(h.writes.at(-1), /\x1b\[\?2004l/u);
    h.tick(); h.advanceTime(1000);
    assert.equal(h.writes.length, afterStop, "queued paint does not write after stop");
    assert.equal(h.renders(), renders, "queued paint does not render after stop");
  }
});

test("truncation keeps renderer colors and closes them", () => {
  const clipped = truncateAnsi(`${style.green("abcdefghij")}tail`, 6);
  assert.equal(stripAnsi(clipped), "abcde…");
  assert.equal(visibleWidth(clipped), 6);
  if (!process.env.NO_COLOR) {
    assert.ok(clipped.startsWith("\x1b[32m"));
    assert.ok(clipped.endsWith("\x1b[0m"));
  }
  assert.equal(stripAnsi(truncateAnsi("tiếng Việt có dấu", 8)), "tiếng V…");
  assert.equal(truncateAnsi("short", 10), "short");
});

test("hint bar drops whole items and keeps the last one visible", async () => {
  const { fitSegments } = await import("../src/layout.mjs");
  const hints = "Enter inspect · / find · w time · v compare · n alerts · ? help · q";
  assert.equal(fitSegments(hints, 200), hints);
  const fitted = fitSegments(hints, 40);
  assert.ok(visibleWidth(fitted) <= 40);
  assert.ok(fitted.endsWith(" · q"), fitted);
  assert.doesNotMatch(fitted, /…/u);
});

test("wrapped colored lines keep their indentation", async () => {
  const { wrapAnsi } = await import("../src/layout.mjs");
  const lines = wrapAnsi(style.dim("  alpha beta gamma delta epsilon"), 14).map(stripAnsi);
  assert.ok(lines.slice(1).every(line => line.startsWith("  ")), JSON.stringify(lines));
});
