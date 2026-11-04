import assert from "node:assert/strict";
import test from "node:test";
import { enrichQuotaPayload } from "../src/quota.mjs";

const NOW = 1_800_000_000_000;
const limit = id => ({ id, label: id, window: { resetsAt: NOW + 3_600_000 }, amount: { usedFraction: 0.2, unit: "percent" }, status: "ok" });
const report = (provider, email, fetchedAt = NOW - 1000) => ({ provider, fetchedAt, metadata: { email }, limits: [limit(`${provider}:5h`)] });
const emails = payload => payload.reports.map(r => r.metadata.email);

test("an account missing from the fresh fetch is kept as stale", () => {
  const out = enrichQuotaPayload({ reports: [report("anthropic", "a@x.test")] },
    { reports: [report("anthropic", "a@x.test"), report("anthropic", "b@x.test", NOW - 3600_000)] }, { now: NOW });
  assert.deepEqual(emails(out), ["a@x.test", "b@x.test"]);
  const kept = out.reports[1];
  assert.equal(kept.missingFromFresh, true);
  assert.equal(kept.status, "stale");
  assert.equal(out.reports[0].missingFromFresh, undefined);
});

test("accounts not seen for over an hour are dropped", () => {
  const out = enrichQuotaPayload({ reports: [report("anthropic", "a@x.test")] },
    { reports: [report("anthropic", "old@x.test", NOW - 2 * 3600_000)] }, { now: NOW });
  assert.deepEqual(emails(out), ["a@x.test"]);
});

test("a second history identity of an account the fresh fetch returned is not a phantom account", () => {
  const out = enrichQuotaPayload({ reports: [report("xai-oauth", "a@x.test")] },
    { reports: [report("xai-oauth", "a@x.test"), report("xai-oauth", "a@x.test", NOW - 60_000)] }, { now: NOW });
  assert.deepEqual(emails(out), ["a@x.test"]);
});

test("retained accounts drop windows that already reset and vanish when none remain", () => {
  const expired = { ...report("anthropic", "gone@x.test"), limits: [{ ...limit("anthropic:5h"), window: { resetsAt: NOW - 1 } }] };
  const mixed = { ...report("anthropic", "mix@x.test"), limits: [{ ...limit("a:old"), window: { resetsAt: NOW - 1 } }, limit("a:live")] };
  const out = enrichQuotaPayload({ reports: [report("anthropic", "a@x.test")] }, { reports: [expired, mixed] }, { now: NOW });
  assert.deepEqual(emails(out), ["a@x.test", "mix@x.test"]);
  assert.deepEqual(out.reports[1].limits.map(l => l.id), ["a:live"]);
});

test("an account OMP reports as disabled is not retained as stale data", () => {
  const out = enrichQuotaPayload({
    reports: [report("openai-codex", "a@x.test")],
    disabledCredentials: [{ id: 2, provider: "openai-codex", email: "dead@x.test", cause: "expired" }],
  }, { reports: [report("openai-codex", "a@x.test"), report("openai-codex", "dead@x.test")] }, { now: NOW });
  assert.deepEqual(emails(out), ["a@x.test"]);
});

test("positional pairing never claims an account another fresh report names", () => {
  const out = enrichQuotaPayload({ reports: [report("p", "b@x.test")] },
    { reports: [report("p", "a@x.test"), report("p", "b@x.test")] }, { now: NOW });
  const merged = out.reports.find(r => r.metadata.email === "b@x.test");
  assert.equal(merged.missingFromFresh, undefined);
  assert.deepEqual(emails(out).sort(), ["a@x.test", "b@x.test"]);
  assert.equal(out.reports.find(r => r.metadata.email === "a@x.test").missingFromFresh, true);
});

test("redacted fresh output still pairs with history by position", () => {
  const out = enrichQuotaPayload({ reports: [report("p", "gr*1*")] },
    { reports: [report("p", "Account 1")] }, { now: NOW });
  assert.equal(out.reports.length, 1);
  assert.equal(out.reports[0].missingFromFresh, undefined);
});
