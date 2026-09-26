import { describe, expect, test } from "bun:test";
import type { UsageSnapshotRow } from "@oh-my-pi/omp-stats/usage-windows";
import { mergeProviderReports, snapshotsToQuota } from "../src/quota";

function row(overrides: Partial<UsageSnapshotRow> = {}): UsageSnapshotRow {
  return {
    recordedAt: 1000,
    provider: "openai-codex",
    accountKey: "acct-a",
    email: "a@example.test",
    accountId: "acct-a",
    limitId: "5h",
    label: "5 Hour",
    windowLabel: "5 Hour",
    usedFraction: 0.2,
    status: "ok",
    ...overrides,
  };
}

describe("snapshotsToQuota", () => {
  test("keeps only the newest snapshot for each account/window", () => {
    const payload = snapshotsToQuota([
      row({ recordedAt: 1000, usedFraction: 0.2 }),
      row({ recordedAt: 2000, usedFraction: 0.6 }),
      row({ accountKey: "acct-b", email: "b@example.test", accountId: "acct-b", usedFraction: 0.3 }),
    ], false);
    expect(payload.reports).toHaveLength(2);
    const a = payload.reports?.find(report => report.metadata?.email === "a@example.test");
    expect(a?.fetchedAt).toBe(2000);
    expect(a?.limits?.[0]?.amount?.usedFraction).toBe(0.6);
  });

  test("redacts persisted account identities", () => {
    const payload = snapshotsToQuota([
      row({ accountKey: "secret-a", email: "private@example.test" }),
      row({ accountKey: "secret-b", email: "other@example.test", accountId: "other" }),
    ], true);
    const labels = payload.reports?.map(report => report.metadata?.accountId);
    expect(labels).toEqual(["Account 1", "Account 2"]);
    expect(JSON.stringify(payload)).not.toContain("private@example.test");
  });
});

describe("mergeProviderReports", () => {
  test("updates one provider progressively without dropping other providers", () => {
    const base = {
      generatedAt: 1000,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: 1000,
          metadata: { email: "a@example.test", planType: "pro" },
          limits: [{ id: "5h", label: "5 Hour", window: { label: "5 Hour", resetsAt: 9999 }, amount: { usedFraction: 0.2 } }],
        },
        {
          provider: "anthropic",
          fetchedAt: 900,
          metadata: { email: "claude@example.test" },
          limits: [{ id: "5h", label: "5 Hour", amount: { usedFraction: 0.4 } }],
        },
      ],
    };
    const merged = mergeProviderReports(base, "openai-codex", [
      {
        provider: "openai-codex",
        fetchedAt: 2000,
        metadata: { email: "a@example.test" },
        limits: [{ id: "5h", label: "5 Hour", amount: { usedFraction: 0.7 } }],
      },
    ]);
    expect(merged.reports?.find(report => report.provider === "anthropic")).toBeTruthy();
    const codex = merged.reports?.find(report => report.provider === "openai-codex");
    expect(codex?.metadata?.planType).toBe("pro");
    expect(codex?.limits?.[0]?.window?.resetsAt).toBe(9999);
    expect(codex?.limits?.[0]?.amount?.usedFraction).toBe(0.7);
  });
});
