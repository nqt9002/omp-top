import { padRight, truncateAnsi } from "./format.mjs";

export class TerminalUI {
  #render;
  #input;
  #started = false;
  #previousRaw = false;
  #onData;
  #onResize;

  constructor({ render, input }) {
    this.#render = render;
    this.#input = input;
    this.#onData = data => this.#handleData(data);
    this.#onResize = () => this.draw();
  }

  get rows() { return Math.max(8, process.stdout.rows || 24); }
  get columns() { return Math.max(40, process.stdout.columns || 100); }

  start() {
    if (this.#started) return;
    this.#started = true;
    this.#previousRaw = Boolean(process.stdin.isRaw);
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", this.#onData);
    process.stdout.on("resize", this.#onResize);
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
    this.draw();
  }

  stop() {
    if (!this.#started) return;
    this.#started = false;
    process.stdin.off("data", this.#onData);
    process.stdout.off("resize", this.#onResize);
    if (process.stdin.setRawMode) {
      try { process.stdin.setRawMode(this.#previousRaw); } catch {}
    }
    process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  }

  draw() {
    if (!this.#started) return;
    const width = this.columns;
    const height = this.rows;
    let lines;
    try { lines = this.#render(width, height) ?? []; }
    catch (error) { lines = [`omp-top render error: ${error instanceof Error ? error.message : String(error)}`]; }
    const normalized = [];
    for (let i = 0; i < height; i++) {
      const line = truncateAnsi(String(lines[i] ?? ""), width);
      normalized.push(padRight(line, width));
    }
    process.stdout.write(`\x1b[H${normalized.join("\n")}`);
  }

  #handleData(data) {
    if (!this.#started) return;
    const value = String(data);
    const known = ["\x1b[5~", "\x1b[6~", "\x1b[A", "\x1b[B", "\x1b[H", "\x1b[F", "\x1b[1~", "\x1b[4~", "\x03", "\x04", "\x1b"];
    if (known.includes(value)) { this.#input(value); return; }
    for (const ch of value) this.#input(ch);
  }
}

export const Keys = {
  ctrlC: "\x03",
  ctrlD: "\x04",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: new Set(["\x1b[H", "\x1b[1~"]),
  end: new Set(["\x1b[F", "\x1b[4~"]),
};
