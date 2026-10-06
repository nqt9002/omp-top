import { padRight, truncateAnsi } from "./format.mjs";

const ESC = "\x1b";
// DEC 2026 synchronized output: terminals that support it present the frame atomically
// (no tearing); terminals that don't simply ignore the private mode.
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
// Alternate screen, hidden cursor, autowrap off (a full-width last row can never scroll).
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J\x1b[H";
const LEAVE = "\x1b[?2004l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l";

// Application-cursor (SS3) and alternate CSI forms normalized to the canonical keys below.
const ALIASES = new Map([
  ["\x1bOA", "\x1b[A"], ["\x1bOB", "\x1b[B"], ["\x1bOC", "\x1b[C"], ["\x1bOD", "\x1b[D"],
  ["\x1bOH", "\x1b[H"], ["\x1bOF", "\x1b[F"],
  ["\x1b[7~", "\x1b[1~"], ["\x1b[8~", "\x1b[4~"],
]);
const SUPPORTED = new Set([
  "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[Z", "\x1b[H", "\x1b[F",
  "\x1b[1~", "\x1b[4~", "\x1b[5~", "\x1b[6~",
]);

const PASTE_END = "\x1b[201~";
const MAX_PASTE_LENGTH = 64 * 1024;

/** Incremental terminal input decoder. Escape sequences may span arbitrary data events. */
export class InputParser {
  #state = "ground";
  #sequence = "";
  #overflow = false;
  #mouseRemaining = 0;
  #stringEscape = false;
  #pasteText = "";
  #pasteEnd = "";
  #afterCR = false;

  get waitingForEscape() { return this.#state === "escape"; }

  reset() {
    this.#state = "ground";
    this.#sequence = "";
    this.#overflow = false;
    this.#mouseRemaining = 0;
    this.#stringEscape = false;
    this.#pasteText = "";
    this.#pasteEnd = "";
    this.#afterCR = false;
  }

  /** Only an isolated ESC is ambiguous; partial CSI/SS3/paste sequences never expire. */
  flushEscape() {
    if (!this.waitingForEscape) return [];
    this.#state = "ground";
    return [{ type: "key", key: ESC }];
  }

  feed(chunk) {
    const events = [];
    for (const char of String(chunk ?? "")) {
      if (this.#state === "paste") {
        // Keep a possible terminator prefix until the next chunk. Everything else,
        // including command letters, newlines and control characters, remains text.
        this.#pasteEnd += char;
        while (this.#pasteEnd && !PASTE_END.startsWith(this.#pasteEnd)) {
          // Retain a bounded prefix, but scan the entire paste for its terminator.
          // Overflow must never turn pasted bytes into keyboard commands.
          if (this.#pasteText.length < MAX_PASTE_LENGTH) this.#pasteText += this.#pasteEnd[0];
          this.#pasteEnd = this.#pasteEnd.slice(1);
        }
        if (this.#pasteEnd === PASTE_END) {
          events.push({ type: "paste", text: this.#pasteText });
          this.#pasteText = this.#pasteEnd = "";
          this.#state = "ground";
        }
        continue;
      }
      // Always leave a way out of an interrupted terminal report. Inside paste,
      // these characters were handled above and remain literal text.
      if (char === "\x03" || char === "\x04") {
        this.reset();
        events.push({ type: "key", key: char });
        continue;
      }
      if (this.#state === "mouse") {
        // The original X10 mouse protocol has three payload characters after CSI M.
        // They can be command letters, so consuming only its CSI header is unsafe.
        if (--this.#mouseRemaining === 0) this.#state = "ground";
        continue;
      }
      if (this.#state === "osc" || this.#state === "string") {
        if ((this.#state === "osc" && char === "\x07") ||
            (this.#stringEscape && char === "\\") || char === "\x9c") {
          this.#state = "ground";
          this.#stringEscape = false;
        } else this.#stringEscape = char === ESC;
        continue;
      }
      if (this.#state === "legacy") {
        // Linux console function keys use ESC [[ A through E.
        this.#state = "ground";
        if (char === ESC) this.#state = "escape";
        continue;
      }
      if (this.#state === "csi" || this.#state === "ss3") {
        if (char === ESC) { this.#state = "escape"; continue; }
        if (char === "\x18" || char === "\x1a") { this.#state = "ground"; continue; }
        const code = char.codePointAt(0);
        if (code < 0x20 || code > 0x7e) continue;
        // Bound malformed sequence storage while still swallowing it through its final.
        if (this.#sequence.length < 128) this.#sequence += char;
        else this.#overflow = true;
        if (code < 0x40) continue;
        const sequence = this.#overflow ? "" : this.#sequence;
        this.#state = "ground";
        if (sequence === "\x1b[200~") this.#state = "paste";
        else if (sequence === "\x1b[M") {
          this.#state = "mouse";
          this.#mouseRemaining = 3;
        } else if (sequence === "\x1b[[") this.#state = "legacy";
        else {
          const canonical = ALIASES.get(sequence) ?? sequence;
          if (SUPPORTED.has(canonical)) events.push({ type: "key", key: canonical });
        }
        continue;
      }
      if (this.#state === "intermediate") {
        if (char === ESC) this.#state = "escape";
        else if (char.codePointAt(0) >= 0x30) this.#state = "ground";
        continue;
      }
      if (this.#state === "escape") {
        this.#state = "ground";
        if (char === ESC) {
          events.push({ type: "key", key: ESC });
          this.#state = "escape";
        } else if (char === "[" || char === "O") {
          this.#state = char === "[" ? "csi" : "ss3";
          this.#sequence = ESC + char;
          this.#overflow = false;
        } else if (char === "]" || "PX^_".includes(char)) {
          this.#state = char === "]" ? "osc" : "string";
          this.#stringEscape = false;
        } else if (char >= " " && char <= "/") this.#state = "intermediate";
        // Other ESC + character combinations are unsupported Alt keys or escapes.
        continue;
      }
      const afterCR = this.#afterCR;
      this.#afterCR = false;
      if (char === "\n" && afterCR) continue;
      if (char === ESC) { this.#state = "escape"; continue; }
      events.push({ type: "key", key: char });
      this.#afterCR = char === "\r";
    }
    return events;
  }
}

/**
 * Compatibility helper for a complete input chunk. Paste is intentionally excluded
 * from key tokens; use InputParser or TerminalUI's paste callback to receive text.
 */
export function parseInput(chunk) {
  const parser = new InputParser();
  return [...parser.feed(chunk), ...parser.flushEscape()]
    .filter(event => event.type === "key").map(event => event.key);
}

export class TerminalUI {
  #render;
  #input;
  #paste;
  #parser = new InputParser();
  #setTimer;
  #clearTimer;
  #escapeTimeout;
  #escapeTimer;
  #stdin;
  #stdout;
  #schedule;
  #started = false;
  #previousRaw = false;
  #onData;
  #onResize;
  #pending = false;
  #frame = [];
  #frameWidth = 0;
  #invalid = true;

  constructor({ render, input, paste = () => {}, stdin = process.stdin, stdout = process.stdout,
    schedule = setImmediate, setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout, escapeTimeout = 30 }) {
    this.#render = render;
    this.#input = input;
    this.#paste = paste;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#escapeTimeout = escapeTimeout;
    this.#stdin = stdin;
    this.#stdout = stdout;
    this.#schedule = schedule;
    this.#onData = data => this.#handleData(data);
    this.#onResize = () => { this.#invalid = true; this.draw(); };
  }

  get rows() { return Math.max(8, this.#stdout.rows || 24); }
  get columns() { return Math.max(40, this.#stdout.columns || 100); }

  start() {
    if (this.#started) return;
    this.#started = true;
    this.#parser.reset();
    this.#previousRaw = Boolean(this.#stdin.isRaw);
    if (this.#stdin.setRawMode) this.#stdin.setRawMode(true);
    this.#stdin.setEncoding?.("utf8");
    this.#stdin.resume?.();
    this.#stdin.on("data", this.#onData);
    this.#stdout.on?.("resize", this.#onResize);
    this.#stdout.write(ENTER);
    this.#invalid = true;
    this.flush();
  }

  stop() {
    if (!this.#started) return;
    this.#started = false;
    this.#cancelEscapeTimer();
    this.#parser.reset();
    this.#pending = false;
    this.#stdin.off("data", this.#onData);
    this.#stdout.off?.("resize", this.#onResize);
    if (this.#stdin.setRawMode) {
      try { this.#stdin.setRawMode(this.#previousRaw); } catch {}
    }
    this.#stdin.pause?.();
    this.#stdout.write(LEAVE);
    this.#frame = [];
  }

  /** Request a frame. Bursts of state changes and key repeats collapse into one paint. */
  draw() {
    if (!this.#started || this.#pending) return;
    this.#pending = true;
    this.#schedule(() => { if (this.#pending) this.flush(); });
  }

  /** Paint immediately, writing only rows that differ from what the terminal shows. */
  flush() {
    this.#pending = false;
    if (!this.#started) return;
    const width = this.columns;
    const height = this.rows;
    let lines;
    try { lines = this.#render(width, height) ?? []; }
    catch (error) { lines = [`omp-top render error: ${error instanceof Error ? error.message : String(error)}`]; }

    const full = this.#invalid || width !== this.#frameWidth || height !== this.#frame.length;
    let out = full ? "\x1b[0m\x1b[2J" : "";
    const next = new Array(height);
    for (let row = 0; row < height; row++) {
      const raw = String(lines[row] ?? "");
      let line = padRight(truncateAnsi(raw, width), width);
      if (line.includes(ESC)) line += "\x1b[0m"; // styles never bleed into the next row
      next[row] = line;
      if (full || line !== this.#frame[row]) out += `\x1b[${row + 1};1H${line}`;
    }
    this.#frame = next;
    this.#frameWidth = width;
    this.#invalid = false;
    if (out) this.#stdout.write(`${SYNC_BEGIN}${out}${SYNC_END}`);
  }

  #cancelEscapeTimer() {
    if (!this.#escapeTimer) return;
    this.#clearTimer(this.#escapeTimer.handle);
    this.#escapeTimer = undefined;
  }

  #dispatch(events) {
    for (const event of events) {
      if (!this.#started) return;
      if (event.type === "paste") this.#paste(event.text);
      else this.#input(event.key);
    }
  }

  #handleData(data) {
    if (!this.#started) return;
    this.#cancelEscapeTimer();
    this.#dispatch(this.#parser.feed(data));
    if (!this.#started || !this.#parser.waitingForEscape) return;
    const timer = {};
    this.#escapeTimer = timer;
    timer.handle = this.#setTimer(() => {
      if (this.#escapeTimer !== timer || !this.#started) return;
      this.#escapeTimer = undefined;
      this.#dispatch(this.#parser.flushEscape());
    }, this.#escapeTimeout);
  }
}

export const Keys = {
  ctrlC: "\x03",
  ctrlD: "\x04",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: new Set(["\x1b[H", "\x1b[1~"]),
  end: new Set(["\x1b[F", "\x1b[4~"]),
};
