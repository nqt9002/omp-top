import assert from "node:assert/strict";
import test from "node:test";
import { quotaDisplayGroups, quotaLimitIdsForDisplay, quotaLimitTitle } from "../src/quota.mjs";
import { renderView } from "../src/views.mjs";
import { setLocale } from "../src/i18n.mjs";
import { stripAnsi } from "../src/format.mjs";

const now = Date.now();
const window = (id, label = id) => ({ id, label, resetsAt: now + 3_600_000 });
const percentAmount = (usedFraction) => ({ usedFraction, remainingFraction: Math.max(0, 1 - usedFraction), unit: "percent" });
const limit = (id, label, provider, extra = {}) => ({
  id,
  label,
  scope: { provider, ...(extra.scope ?? {}) },
  ...(extra.window === null ? {} : { window: extra.window ?? window("monthly", "Monthly") }),
  amount: extra.amount ?? percentAmount(0.25),
  ...(extra.status ? { status: extra.status } : {}),
  ...(extra.notes ? { notes: extra.notes } : {}),
});
const report = (provider, limits, extra = {}) => ({
  provider,
  fetchedAt: now,
  limits,
  metadata: extra.metadata ?? { accountId: provider + "-acct" },
  ...(extra.notes ? { notes: extra.notes } : {}),
  ...(extra.resetCredits ? { resetCredits: extra.resetCredits } : {}),
});

test("quota title preserves Claude shared and model-family weekly counters", () => {
  const limits = [
    limit("anthropic:5h", "Claude 5 Hour", "anthropic", { scope: { shared: true, windowId: "5h" }, window: window("5h", "5 Hour") }),
    limit("anthropic:7d", "Claude 7 Day", "anthropic", { scope: { shared: true, windowId: "7d" }, window: window("7d", "7 Day") }),
    limit("anthropic:7d:opus", "Claude 7 Day (Opus)", "anthropic", { scope: { tier: "opus", windowId: "7d" }, window: window("7d", "7 Day") }),
    limit("anthropic:7d:sonnet", "Claude 7 Day (Sonnet)", "anthropic", { scope: { tier: "sonnet", windowId: "7d" }, window: window("7d", "7 Day") }),
    limit("anthropic:7d:fable", "Claude 7 Day (Fable)", "anthropic", { scope: { tier: "fable", windowId: "7d" }, window: window("7d", "7 Day") }),
    limit("anthropic:7d:mythos", "Claude 7 Day (Mythos)", "anthropic", { scope: { tier: "mythos", windowId: "7d" }, window: window("7d", "7 Day") }),
  ];
  assert.deepEqual(limits.map(quotaLimitTitle), [
    "Claude 5 Hour",
    "Claude 7 Day",
    "Claude 7 Day (Opus)",
    "Claude 7 Day (Sonnet)",
    "Claude 7 Day (Fable)",
    "Claude 7 Day (Mythos)",
  ]);
});

test("generic providers preserve every fresh OMP UsageLimit id", () => {
  const reports = [
    report("anthropic", [
      limit("anthropic:5h", "Claude 5 Hour", "anthropic"),
      limit("anthropic:7d:fable", "Claude 7 Day (Fable)", "anthropic", { scope: { tier: "fable" } }),
    ]),
    report("openai-codex", [
      limit("openai-codex:primary", "5 hours", "openai-codex"),
      limit("openai-codex:spark:primary", "5 hours (Spark)", "openai-codex", { scope: { tier: "spark", modelId: "GPT-5.3-Codex-Spark" } }),
    ]),
    report("google-gemini-cli", [
      limit("gemini-3.8-flash:quota", "Gemini gemini-3.8-flash", "google-gemini-cli", { scope: { modelId: "gemini-3.8-flash", tier: "3-Flash" }, window: window("quota", "Quota window") }),
      limit("gemini-3.8-pro:quota", "Gemini gemini-3.8-pro", "google-gemini-cli", { scope: { modelId: "gemini-3.8-pro", tier: "Pro" }, window: window("quota-2", "Quota window") }),
    ]),
    report("github-copilot", [
      limit("premium", "Premium Requests", "github-copilot"),
      limit("chat", "Chat Requests", "github-copilot"),
      limit("completions", "Completions", "github-copilot"),
      limit("model:gpt-5", "Model gpt-5", "github-copilot", { scope: { modelId: "gpt-5" } }),
    ]),
    report("zai", [
      limit("zai:tokens:1mo", "ZAI Monthly Token Quota", "zai"),
      limit("zai:requests:5h", "ZAI Request Quota", "zai"),
      limit("zai:features:web-search-reader-zread:1w", "ZAI Web Search / Reader / Zread Quota", "zai", { scope: { tier: "web-search-reader-zread" } }),
    ]),
    report("opencode-go", [
      limit("rolling-5h", "5 Hour limit", "opencode-go"),
      limit("weekly", "Weekly limit", "opencode-go"),
      limit("monthly", "Monthly limit", "opencode-go"),
    ]),
    report("kimi-code", [
      limit("kimi-code:0", "Total quota", "kimi-code"),
      limit("kimi-code:1", "5h limit", "kimi-code"),
    ]),
    report("cursor", [
      limit("cursor:requests:gpt-4", "gpt-4 requests", "cursor"),
      limit("cursor:usd:planusage", "planUsage spend", "cursor"),
    ]),
    report("ollama", []),
    report("ollama-cloud", []),
  ];

  for (const item of reports) {
    const source = item.limits.map(row => row.id).sort();
    const displayed = quotaLimitIdsForDisplay(item).sort();
    assert.deepEqual(displayed, source, item.provider);
  }
});

test("provider matrix renders semantic labels, absolute amounts, notes and reset credits", () => {
  setLocale("en");
  const reports = [
    report("anthropic", [
      limit("anthropic:5h", "Claude 5 Hour", "anthropic", { window: window("5h", "5 Hour") }),
      limit("anthropic:7d", "Claude 7 Day", "anthropic", { window: window("7d", "7 Day") }),
      limit("anthropic:7d:fable", "Claude 7 Day (Fable)", "anthropic", { scope: { tier: "fable" }, window: window("7d", "7 Day") }),
      limit("anthropic:7d:mythos", "Claude 7 Day (Mythos)", "anthropic", { scope: { tier: "mythos" }, window: window("7d", "7 Day") }),
    ]),
    report("openai-codex", [
      limit("openai-codex:primary", "5 hours", "openai-codex", { window: window("5h", "5 Hour") }),
      limit("openai-codex:spark:primary", "5 hours (Spark)", "openai-codex", { scope: { tier: "spark", modelId: "GPT-5.3-Codex-Spark" }, window: window("5h", "5 Hour") }),
    ], {
      metadata: { accountId: "codex", planType: "Pro" },
      resetCredits: { availableCount: 2, credits: [{ expiresAt: new Date(now + 86_400_000).toISOString() }] },
    }),
    report("google-antigravity", [
      limit("google-antigravity:google:default:weekly", "Usage (Google)", "google-antigravity", { scope: { windowId: "weekly" }, window: window("weekly", "Weekly") }),
      limit("google-antigravity:anthropic:default:weekly", "Usage (Anthropic)", "google-antigravity", { scope: { windowId: "weekly" }, window: window("weekly", "Weekly") }),
      limit("google-antigravity:openai:default:weekly", "Usage (OpenAI)", "google-antigravity", { scope: { windowId: "weekly" }, window: window("weekly", "Weekly") }),
    ]),
    report("google-gemini-cli", [
      limit("gemini-3.8-flash:q", "Gemini gemini-3.8-flash", "google-gemini-cli", { scope: { modelId: "gemini-3.8-flash", tier: "3-Flash" }, window: window("q", "Quota window") }),
    ], { metadata: { accountId: "gemini", currentTierName: "Google AI Pro" } }),
    report("github-copilot", [
      limit("premium", "Premium Requests", "github-copilot", { notes: ["Overage requests: 3"] }),
      limit("chat", "Chat Requests", "github-copilot", { notes: ["Unlimited"] }),
      limit("completions", "Completions", "github-copilot"),
      limit("model:gpt-5", "Model gpt-5", "github-copilot", { scope: { modelId: "gpt-5" } }),
    ]),
    report("zai", [
      limit("zai:tokens:1mo", "ZAI Monthly Token Quota", "zai"),
      limit("zai:requests:5h", "ZAI Request Quota", "zai"),
      limit("zai:features:web-search-reader-zread:1w", "ZAI Web Search / Reader / Zread Quota", "zai", { scope: { tier: "web-search-reader-zread" } }),
    ]),
    report("opencode-go", [
      limit("rolling-5h", "5 Hour limit", "opencode-go", {
        window: window("rolling-5h", "5 Hour"),
        amount: { used: 5, limit: 12, remaining: 7, usedFraction: 5 / 12, unit: "usd" },
      }),
    ], { notes: ["OMP-observed spend only; OpenCode usage outside OMP is not included."] }),
    report("kimi-code", [
      limit("kimi-code:0", "Total quota", "kimi-code"),
      limit("kimi-code:1", "5h limit", "kimi-code", { window: window("5h", "5 Hour") }),
    ]),
    report("cursor", [
      limit("cursor:requests:gpt-4", "gpt-4 requests", "cursor", {
        amount: { used: 200, limit: 500, remaining: 300, usedFraction: 0.4, unit: "requests" },
      }),
      limit("cursor:usd:planusage", "planUsage spend", "cursor", {
        amount: { used: 8.5, limit: 20, remaining: 11.5, usedFraction: 0.425, unit: "usd" },
      }),
    ]),
    report("ollama", [], { notes: ["Ollama does not expose a standalone quota usage API; per-response token usage is reported during requests."] }),
    report("ollama-cloud", [], { notes: ["Ollama does not expose a standalone quota usage API; per-response token usage is reported during requests."] }),
  ];

  const screen = stripAnsi(renderView("quota", { quota: { reports }, providerStates: new Map(), quotaRefreshing: false }, 156).join("\n"));

  for (const expected of [
    "Claude 7 Day (Fable)",
    "Claude 7 Day (Mythos)",
    "5 hours (Spark)",
    "Usage (Google)",
    "Usage (Anthropic)",
    "Usage (OpenAI)",
    "Gemini gemini-3.8-flash",
    "Premium Requests",
    "Chat Requests",
    "Completions",
    "Model gpt-5",
    "ZAI Monthly Token Quota",
    "ZAI Request Quota",
    "ZAI Web Search / Reader / Zread Quota",
    "5 Hour limit",
    "Total quota",
    "gpt-4 requests",
    "planUsage spend",
    "Google AI Pro",
    "2 saved resets",
    "Overage requests: 3",
    "Unlimited",
    "$5.00 / $12.0",
    "OMP-observed spend only",
    "No standalone quota API",
  ]) assert.ok(screen.includes(expected), expected);
});

test("current Antigravity backend counters stay distinct", () => {
  const item = report("google-antigravity", [
    limit("google-antigravity:google:default:weekly", "Usage (Google)", "google-antigravity", { scope: { windowId: "weekly" }, window: window("weekly", "Weekly") }),
    limit("google-antigravity:anthropic:default:weekly", "Usage (Anthropic)", "google-antigravity", { scope: { windowId: "weekly" }, window: window("weekly", "Weekly") }),
    limit("google-antigravity:openai:default:weekly", "Usage (OpenAI)", "google-antigravity", { scope: { windowId: "weekly" }, window: window("weekly", "Weekly") }),
  ]);
  assert.deepEqual(quotaLimitIdsForDisplay(item).sort(), item.limits.map(row => row.id).sort());
});

test("Antigravity intentional shared-counter dedupe remains intact", () => {
  const item = report("google-antigravity", [
    limit("a", "Claude & GPT (shared)", "google-antigravity", { scope: { shared: true, sharedGroup: "3p:weekly", windowId: "weekly" }, window: window("weekly", "Weekly"), amount: percentAmount(0.2) }),
    limit("b", "Claude & GPT (shared)", "google-antigravity", { scope: { shared: true, sharedGroup: "3p:weekly", windowId: "weekly" }, window: window("weekly", "Weekly"), amount: percentAmount(0.3) }),
  ]);
  const groups = quotaDisplayGroups(item);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].limits.length, 1);
  assert.equal(groups[0].limits[0].amount.usedFraction, 0.3);
});


test("narrow quota view keeps Fable identity visible instead of reducing it to a generic 7 Day row", () => {
  setLocale("en");
  const item = report("anthropic", [
    limit("anthropic:7d", "Claude 7 Day", "anthropic", { window: window("7d", "7 Day") }),
    limit("anthropic:7d:fable", "Claude 7 Day (Fable)", "anthropic", {
      scope: { tier: "fable", windowId: "7d" },
      window: window("7d", "7 Day"),
    }),
  ]);
  const screen = stripAnsi(renderView("quota", { quota: { reports: [item] }, providerStates: new Map(), quotaRefreshing: false }, 60).join("\n"));
  assert.match(screen, /Claude 7 Day \(Fable\)/);
  assert.match(screen, /Claude 7 Day/);
});




test("Anthropic quota keeps Fable visible without source-coverage debug text", () => {
  setLocale("vi");
  const item = report("anthropic", [
    limit("anthropic:5h", "Claude 5 Hour", "anthropic", { scope: { shared: true, windowId: "5h" }, window: window("5h", "5 Hour") }),
    limit("anthropic:7d", "Claude 7 Day", "anthropic", { scope: { shared: true, windowId: "7d" }, window: window("7d", "7 Day") }),
    limit("anthropic:7d:fable", "Claude 7 Day (Fable)", "anthropic", { scope: { tier: "fable", windowId: "7d" }, window: window("7d", "7 Day") }),
  ]);
  const screen = stripAnsi(renderView("quota", { quota: { reports: [item] }, providerStates: new Map(), quotaRefreshing: false }, 120).join("\n"));
  assert.match(screen, /Claude 7 Day \(Fable\)/);
  assert.doesNotMatch(screen, /Nguồn OMP/);
  assert.doesNotMatch(screen, /model-scoped weekly quota/);
});


test("dense Antigravity quota view flattens groups and suppresses healthy intelligence noise", () => {
  setLocale("vi");
  const resetWeekly = now + 3 * 24 * 60 * 60 * 1000;
  const reset5h = now + 5 * 60 * 60 * 1000;
  const healthyIntel = {
    sampleCount: 4,
    status: "ok",
    recentBurnPerHour: 0,
    sustainablePerHour: 0.2,
    recentPaceRatio: 0,
  };
  const makeAccount = accountId => report("google-antigravity", [
    limit(accountId + ":gemini:weekly", "Gemini", "google-antigravity", {
      scope: { accountId, windowId: "weekly" },
      window: { id: "weekly", label: "Weekly", resetsAt: resetWeekly },
      amount: percentAmount(0.39),
    }),
    { ...limit(accountId + ":gemini:5h", "Gemini", "google-antigravity", {
      scope: { accountId, windowId: "5h" },
      window: { id: "5h", label: "5 Hour", resetsAt: reset5h },
      amount: percentAmount(0),
    }), intelligence: healthyIntel },
    { ...limit(accountId + ":shared:weekly", "Claude & GPT (shared)", "google-antigravity", {
      scope: { accountId, shared: true, sharedGroup: accountId + ":shared:weekly", windowId: "weekly" },
      window: { id: "weekly", label: "Weekly", resetsAt: resetWeekly },
      amount: percentAmount(0),
    }), intelligence: healthyIntel },
    { ...limit(accountId + ":shared:5h", "Claude & GPT (shared)", "google-antigravity", {
      scope: { accountId, shared: true, sharedGroup: accountId + ":shared:5h", windowId: "5h" },
      window: { id: "5h", label: "5 Hour", resetsAt: reset5h },
      amount: percentAmount(0),
    }), intelligence: healthyIntel },
  ], { metadata: { accountId } });

  const screen = stripAnsi(renderView("quota", {
    quota: { reports: [makeAccount("gr*1*"), makeAccount("gr*4*")] },
    providerStates: new Map([["google-antigravity", { status: "fresh", updatedAt: now }]]),
    quotaRefreshing: false,
    quotaNextAt: now + 5 * 60 * 1000,
    now,
  }, 156).join("\n"));

  assert.match(screen, /Gemini Weekly/);
  assert.match(screen, /Gemini 5 Hour/);
  assert.match(screen, /Claude & GPT \(shared\) Weekly/);
  assert.match(screen, /Claude & GPT \(shared\) 5 Hour/);
  assert.doesNotMatch(screen, /refresh ↻/);
  assert.doesNotMatch(screen, /ETA -/);
  assert.doesNotMatch(screen, /0\.0%\/h/);
  assert.ok(screen.split("\n").length <= 15, screen);
});

test("Quota renders intelligence only for interesting risky limits", () => {
  setLocale("en");
  const safe = {
    ...limit("safe", "Healthy Weekly", "openai-codex", {
      window: { id: "safe", label: "Weekly", resetsAt: now + 7 * 24 * 60 * 60 * 1000 },
      amount: percentAmount(0.2),
    }),
    intelligence: {
      sampleCount: 5,
      status: "ok",
      recentBurnPerHour: 0.01,
      sustainablePerHour: 0.02,
      recentPaceRatio: 0.5,
      recentProjectedExhaustAt: now + 80 * 60 * 60 * 1000,
    },
  };
  const risky = {
    ...limit("risky", "Risky Weekly", "openai-codex", {
      window: { id: "risky", label: "Weekly", resetsAt: now + 7 * 24 * 60 * 60 * 1000 },
      amount: percentAmount(0.4),
    }),
    intelligence: {
      sampleCount: 5,
      status: "at-risk",
      recentBurnPerHour: 0.04,
      sustainablePerHour: 0.005,
      recentPaceRatio: 8,
      recentProjectedExhaustAt: now + 15 * 60 * 60 * 1000,
    },
  };
  const screen = stripAnsi(renderView("quota", {
    quota: { reports: [report("openai-codex", [safe, risky], { metadata: { accountId: "codex" } })] },
    providerStates: new Map([["openai-codex", { status: "fresh", updatedAt: now }]]),
    quotaRefreshing: false,
    quotaNextAt: now + 5 * 60 * 1000,
    now,
  }, 120).join("\n"));

  assert.match(screen, /Healthy Weekly/);
  assert.match(screen, /Risky Weekly/);
  assert.match(screen, /burn 4\.0%\/h · ETA 15h · safe 0\.5%\/h · pace 8\.00×/);
  const safeIndex = screen.indexOf("Healthy Weekly");
  const riskyIndex = screen.indexOf("Risky Weekly");
  const between = screen.slice(safeIndex, riskyIndex);
  assert.doesNotMatch(between, /burn|ETA/);
  assert.doesNotMatch(screen, /reset ↻|ETA ↻/);
});
