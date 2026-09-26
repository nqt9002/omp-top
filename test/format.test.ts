import { describe, expect, test } from "bun:test";
import {
  accountLabel,
  extractJsonPayload,
  formatPercent,
  formatReset,
  providerLabel,
  resolveUsedFraction,
} from "../src/format";

describe("format helpers", () => {
  test("extracts JSON after banners", () => {
    expect(extractJsonPayload('warning\n{"ok":true}\ntrailing')).toBe('{"ok":true}');
  });

  test("resolves quota fractions", () => {
    expect(resolveUsedFraction({ usedFraction: 0.25 })).toBe(0.25);
    expect(resolveUsedFraction({ used: 5, limit: 10 })).toBe(0.5);
    expect(resolveUsedFraction({ used: 20, unit: "percent" })).toBe(0.2);
    expect(resolveUsedFraction({ remainingFraction: 0.3 })).toBeCloseTo(0.7);
  });

  test("formats labels", () => {
    expect(providerLabel("openai-codex")).toBe("OpenAI Codex");
    expect(providerLabel("some-provider")).toBe("Some Provider");
    expect(accountLabel({ email: "a@example.com" }, "Account")).toBe("a@example.com");
  });

  test("formats percent and reset", () => {
    expect(formatPercent(0.423)).toBe("42%");
    expect(formatReset(1_700_000_000_000 + 90 * 60_000, 1_700_000_000_000)).toBe("reset 1h 30m");
  });
});
