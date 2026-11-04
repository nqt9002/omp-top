import assert from "node:assert/strict";
import test from "node:test";
import { setLocale } from "../src/i18n.mjs";
import { stripAnsi } from "../src/format.mjs";
import { disabledAccounts, enrichQuotaPayload } from "../src/quota.mjs";
import { renderView } from "../src/views.mjs";

const limit = { id: "openai-codex:primary", label: "30 days", window: { label: "30 days" }, amount: { usedFraction: 0.1, unit: "percent" }, status: "ok" };
const payload = {
  generatedAt: 2,
  reports: [{ provider: "openai-codex", fetchedAt: 2, metadata: { email: "active@example.test" }, limits: [limit] }],
  disabledCredentials: [{
    id: 2, provider: "openai-codex", type: "oauth", email: "expired@example.test", accountId: "acct-2",
    cause: "oauth refresh failed: 401 refresh_token_invalidated: Your session has ended. Please log in again.",
    disabledAtMs: 1,
  }],
};

function screen(quota, width = 110) {
  return stripAnsi(renderView("quota", { quota, providerStates: new Map(), now: 10 }, width, 40).join("\n"));
}

test("disabledAccounts normalizes disabled credentials and ignores malformed entries", () => {
  const accounts = disabledAccounts({ disabledCredentials: [payload.disabledCredentials[0], null, { id: 1 }] });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].account, "expired@example.test");
  assert.equal(accounts[0].provider, "openai-codex");
  assert.deepEqual(disabledAccounts({}), []);
});

test("enrichment keeps disabled credentials from the fresh payload", () => {
  assert.equal(disabledAccounts(enrichQuotaPayload(payload, { reports: [] })).length, 1);
});

for (const [locale, warning, hint] of [["en", /login expired/, /Sign in to this account again/], ["vi", /đăng nhập hết hạn/, /đăng nhập lại tài khoản này/]]) {
  test(`expired account shows a login warning next to the active one (${locale})`, () => {
    setLocale(locale);
    try {
      const text = screen(payload);
      assert.match(text, /active@example\.test/);
      assert.match(text, /expired@example\.test/);
      assert.match(text, warning);
      assert.match(text, hint);
      assert.match(text, /refresh_token_invalidated/);
    } finally { setLocale("en"); }
  });
}

test("a provider with only expired accounts is still listed", () => {
  const text = screen({ generatedAt: 1, reports: [], disabledCredentials: payload.disabledCredentials });
  assert.match(text, /expired@example\.test/);
  assert.match(text, /login expired/);
  assert.doesNotMatch(text, /No quota data available/);
});
