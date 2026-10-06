import assert from "node:assert/strict";
import test from "node:test";
import { QuotaAlertPolicy, QUOTA_ALERT_MAX_AGE_MS } from "../src/quota-alerts.mjs";

const START = 1_800_000_000_000;
function payload(at = START, { used = 1, status, account = "account-a", reset = START + 3_600_000, scope = {}, id = "daily", provider = "openai", intelligence } = {}) {
  return { reports: [{ provider, fetchedAt: at, metadata: { accountId: account }, limits: [{ id, scope, amount: { usedFraction: used }, window: { id: "daily", resetsAt: reset }, status, intelligence }] }] };
}
function enabled() { const policy = new QuotaAlertPolicy(); policy.setEnabled(true); return policy; }
function check(policy, data, now = START, providerStates) { return policy.evaluate(data, { now, providerStates }); }

test("disabled by default and enabling waits for newer evidence after disabled snapshots", () => {
  const policy = new QuotaAlertPolicy();
  assert.equal(policy.enabled, false);
  assert.deepEqual(check(policy, payload()), []);
  policy.setEnabled(true);
  assert.deepEqual(check(policy, payload()), []);
  assert.equal(check(policy, payload(START + 1), START + 1).length, 1);
  policy.setEnabled(false);
  check(policy, payload(START + 2), START + 2);
  policy.setEnabled(true);
  assert.deepEqual(check(policy, payload(START + 2), START + 2), []);
  assert.deepEqual(check(policy, payload(START + 3), START + 3), []);
});

test("fresh critical emits once with no account details and new snapshots stay deduplicated", () => {
  const policy = enabled();
  const alerts = check(policy, payload());
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].status, "exhausted");
  assert.equal(JSON.stringify(alerts).includes("account-a"), false);
  assert.deepEqual(check(policy, payload()), []);
  assert.deepEqual(check(policy, payload(START + 1), START + 1), []);
});

test("forecast risk escalates once and severity fluctuation does not repeat exhaustion", () => {
  const policy = enabled();
  const risk = at => payload(at, { used: 0.5, intelligence: { status: "at-risk" } });
  assert.equal(check(policy, risk(START))[0].status, "at-risk");
  assert.equal(check(policy, payload(START + 1), START + 1)[0].status, "exhausted");
  assert.deepEqual(check(policy, risk(START + 2), START + 2), []);
  assert.deepEqual(check(policy, payload(START + 3), START + 3), []);
  assert.deepEqual(check(enabled(), payload(START, { used: 0.95 })), []);
});

test("freshness boundary, future clock, absent timestamps, and reset deadlines", () => {
  assert.equal(check(enabled(), payload(), START + QUOTA_ALERT_MAX_AGE_MS).length, 1);
  assert.deepEqual(check(enabled(), payload(), START + QUOTA_ALERT_MAX_AGE_MS + 1), []);
  assert.deepEqual(check(enabled(), payload(START + 1)), []);
  for (const fetchedAt of [undefined, null, NaN, Infinity, "1800000000000", 0]) {
    const data = payload(); data.reports[0].fetchedAt = fetchedAt;
    assert.deepEqual(check(enabled(), data), []);
  }
  for (const reset of [START - 1, START, null, NaN]) assert.deepEqual(check(enabled(), payload(START, { reset })), []);
  assert.deepEqual(check(enabled(), payload(), NaN), []);
});

test("stale, refreshing and failed reports never notify or establish recovery", () => {
  for (const status of ["stale", "refreshing", "error"]) {
    const policy = enabled();
    const states = new Map([["openai", { status }]]);
    assert.deepEqual(check(policy, payload(), START, states), []);
    assert.equal(check(policy, payload(), START, { openai: { status: "fresh" } }).length, 1);
    assert.deepEqual(check(policy, payload(START + 1, { used: 0.1 }), START + 1, states), []);
    assert.deepEqual(check(policy, payload(START + 2), START + 2), []);
  }
});

test("recovery requires newer fresh evidence and then permits another alert", () => {
  const policy = enabled();
  check(policy, payload());
  check(policy, payload(START, { used: 0.1 }));
  assert.deepEqual(check(policy, payload(START + 1), START + 1), []);
  check(policy, payload(START + 2, { used: 0.1 }), START + 2);
  assert.equal(check(policy, payload(START + 3), START + 3).length, 1);
});

test("accounts, models, tiers, and windows remain independent", () => {
  const policy = enabled();
  for (const options of [{}, { account: "account-b" }, { scope: { model: "m1" } }, { scope: { tier: "premium" } }, { scope: { windowId: "weekly" } }]) {
    assert.equal(check(policy, payload(START, options)).length, 1);
  }
});

test("new reset cycles alert again but future reset corrections do not", () => {
  const policy = enabled();
  check(policy, payload(START, { reset: START + 100 }));
  assert.deepEqual(check(policy, payload(START + 1, { reset: START + 101 }), START + 1), []);
  assert.equal(check(policy, payload(START + 102, { reset: START + 500 }), START + 102).length, 1);
});

test("Antigravity shared counters normalize to one bucket across routing changes", () => {
  const policy = enabled();
  const data = payload(START, { provider: "google-antigravity" });
  data.reports[0].limits = ["anthropic", "openai"].map((provider, index) => ({
    id: provider, label: "Claude/GPT (shared)", scope: { provider, sharedGroup: "third-party" },
    window: { label: "weekly", resetsAt: START + 1000 }, amount: { usedFraction: index ? 1 : 0.9 },
  }));
  assert.equal(check(policy, data).length, 1);
  data.reports[0].fetchedAt++;
  data.reports[0].limits.reverse();
  assert.deepEqual(check(policy, data, START + 1), []);
});

test("future snapshots can be retried when the clock catches up", () => {
  const policy = enabled();
  assert.deepEqual(check(policy, payload(START + 100)), []);
  assert.equal(check(policy, payload(START + 100), START + 100).length, 1);
});

test("stale healthy snapshots cannot reset deduplication", () => {
  const policy = enabled();
  check(policy, payload());
  check(policy, payload(START + 1, { used: 0.1 }), START + QUOTA_ALERT_MAX_AGE_MS + 2);
  const later = START + QUOTA_ALERT_MAX_AGE_MS + 3;
  assert.deepEqual(check(policy, payload(later), later), []);
});

test("amount ratios and remaining fractions produce exhaustion evidence", () => {
  for (const amount of [{ used: 10, limit: 10 }, { remainingFraction: 0 }]) {
    const data = payload();
    data.reports[0].limits[0].amount = amount;
    assert.equal(check(enabled(), data)[0].usedFraction, 1);
  }
});

test("alert labels use readable quota titles", () => {
  const data = payload(START, { scope: { tier: "premium" } });
  data.reports[0].limits[0].label = "Messages";
  data.reports[0].limits[0].window.label = "Weekly";
  assert.equal(check(enabled(), data)[0].label, "Messages (premium) (Weekly)");
});

test("historical intelligence alone cannot notify without current reset evidence", () => {
  for (const status of ["at-risk", "exhausted"]) {
    const data = payload(START, { used: 0.2, intelligence: { status, resetsAt: START + 10_000 } });
    delete data.reports[0].limits[0].window.resetsAt;
    assert.deepEqual(check(enabled(), data), []);
  }
  const current = payload();
  delete current.reports[0].limits[0].window.resetsAt;
  assert.equal(check(enabled(), current)[0].status, "exhausted");
});

test("unknown observations do not notify or clear an existing alert", () => {
  const policy = enabled();
  check(policy, payload());
  const unknown = payload(START + 1, { used: undefined, status: "unknown", intelligence: { status: "at-risk" } });
  assert.deepEqual(check(policy, unknown, START + 1), []);
  assert.deepEqual(check(policy, payload(START + 2), START + 2), []);
});
