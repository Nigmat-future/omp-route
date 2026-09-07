import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackPlan,
  canonicalizeModel,
  createOverlay,
  groupEquivalentModels,
  summarizeProviderUsage,
} from "../src/core.js";

const model = (provider, id, name, overrides = {}) => ({
  provider,
  id,
  selector: `${provider}/${id}`,
  name,
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  reasoning: true,
  thinking: ["low", "medium", "high", "xhigh", "max"],
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...overrides,
});

test("canonicalizes provider-specific Claude Fable 5 selectors", () => {
  const variants = [
    model("cctq-claude", "claude-fable-5", "Claude Fable 5 (CCTQ)"),
    model("cursor", "claude-fable-5-high", "Claude Fable 5 1M (NO ZDR)"),
    model("openrouter", "anthropic/claude-fable-5", "Claude Fable 5"),
  ].map(canonicalizeModel);

  assert.deepEqual(variants.map((entry) => entry.canonicalKey), [
    "claude-fable@5",
    "claude-fable@5",
    "claude-fable@5",
  ]);
  assert.equal(variants[1].profile, "high");
  assert.ok(variants.every((entry) => entry.confidence === "high"));
});

test("keeps Fable 5 and Fable 5.1 in separate groups", () => {
  const v5 = canonicalizeModel(
    model("cursor", "claude-fable-5-high", "Claude Fable 5 1M"),
  );
  const v51 = canonicalizeModel(
    model("cursor", "claude-fable-5-1-high", "Claude Fable 5.1 1M"),
  );

  assert.equal(v5.canonicalKey, "claude-fable@5");
  assert.equal(v51.canonicalKey, "claude-fable@5.1");
  assert.notEqual(v5.canonicalKey, v51.canonicalKey);
});

test("rejects ambiguous latest aliases and non-interactive batch variants", () => {
  const latest = canonicalizeModel(
    model("openrouter", "~anthropic/claude-fable-latest", "Claude Fable Latest"),
  );
  const batch = canonicalizeModel(
    model("openrouter", "anthropic/claude-fable-5:batch", "Claude Fable 5 (batch)"),
  );

  assert.equal(latest.routeEligible, false);
  assert.equal(latest.exclusionReason, "ambiguous-latest-alias");
  assert.equal(batch.routeEligible, false);
  assert.equal(batch.exclusionReason, "non-interactive-variant");
});

test("uses exact normalized model ids as a conservative generic fallback", () => {
  const direct = canonicalizeModel(model("provider-a", "glm-5.3", "GLM 5.3"));
  const namespaced = canonicalizeModel(
    model("openrouter", "z-ai/glm-5.3", "GLM 5.3"),
  );

  assert.equal(direct.canonicalKey, "exact:glm-5.3");
  assert.equal(namespaced.canonicalKey, "exact:glm-5.3");
  assert.equal(direct.confidence, "exact-id");
});

test("only returns routable groups spanning multiple providers", () => {
  const groups = groupEquivalentModels([
    model("cctq-claude", "claude-fable-5", "Claude Fable 5 (CCTQ)"),
    model("cursor", "claude-fable-5-high", "Claude Fable 5 1M"),
    model("cursor", "claude-fable-5-low", "Claude Fable 5 1M Low"),
    model("openrouter", "anthropic/claude-fable-5", "Claude Fable 5"),
    model("openrouter", "anthropic/claude-fable-5:batch", "Claude Fable 5 (batch)"),
    model("solo", "unique-model-1", "Unique Model 1"),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonicalKey, "claude-fable@5");
  assert.deepEqual(
    [...new Set(groups[0].models.map((entry) => entry.provider))].sort(),
    ["cctq-claude", "cursor", "openrouter"],
  );
  assert.ok(groups[0].models.every((entry) => !entry.id.endsWith(":batch")));
});

test("summarizes the most restrictive reported quota for each provider", () => {
  const signals = summarizeProviderUsage({
    reports: [
      {
        provider: "cursor",
        limits: [
          { amount: { remainingFraction: 0.8 } },
          { amount: { usedFraction: 0.4 } },
        ],
      },
      {
        provider: "openrouter",
        limits: [{ amount: { remainingFraction: 0 } }],
      },
    ],
    disabledCredentials: [{ provider: "disabled-provider" }],
  });

  assert.deepEqual(signals.cursor, {
    disabled: false,
    quotaKnown: true,
    remainingFraction: 0.6,
  });
  assert.equal(signals.openrouter.remainingFraction, 0);
  assert.equal(signals["disabled-provider"].disabled, true);
});

test("builds a fallback chain for every selectable provider variant", () => {
  const models = [
    model("cctq-claude", "claude-fable-5", "Claude Fable 5 (CCTQ)"),
    model("cursor", "claude-fable-5-high", "Claude Fable 5 1M"),
    model("cursor", "claude-fable-5-low", "Claude Fable 5 1M Low"),
    model("openrouter", "anthropic/claude-fable-5", "Claude Fable 5", {
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    }),
  ];
  const usage = {
    reports: [
      { provider: "cursor", limits: [{ amount: { remainingFraction: 0.7 } }] },
      { provider: "openrouter", limits: [{ amount: { remainingFraction: 0.4 } }] },
    ],
  };
  const plan = buildFallbackPlan(models, usage);

  assert.deepEqual(plan.fallbackChains["cctq-claude/claude-fable-5"], [
    "cursor/claude-fable-5-high",
    "openrouter/anthropic/claude-fable-5",
  ]);
  assert.deepEqual(plan.fallbackChains["cursor/claude-fable-5-low"], [
    "openrouter/anthropic/claude-fable-5:low",
    "cctq-claude/claude-fable-5:low",
  ]);
  assert.deepEqual(plan.fallbackChains["openrouter/anthropic/claude-fable-5"], [
    "cursor/claude-fable-5-high",
    "cctq-claude/claude-fable-5",
  ]);
  assert.equal(plan.routes.length, 4);
});

test("puts unknown quota ahead of exhausted providers and omits disabled providers", () => {
  const models = [
    model("primary", "glm-5.3", "GLM 5.3"),
    model("unknown", "glm-5.3", "GLM 5.3"),
    model("exhausted", "glm-5.3", "GLM 5.3"),
    model("disabled", "glm-5.3", "GLM 5.3"),
  ];
  const plan = buildFallbackPlan(models, {
    reports: [
      { provider: "primary", limits: [{ amount: { remainingFraction: 0.5 } }] },
      { provider: "exhausted", limits: [{ amount: { remainingFraction: 0 } }] },
    ],
    disabledCredentials: [{ provider: "disabled" }],
  });

  assert.deepEqual(plan.fallbackChains["primary/glm-5.3"], [
    "unknown/glm-5.3",
    "exhausted/glm-5.3",
  ]);
  assert.ok(!plan.fallbackChains["primary/glm-5.3"].includes("disabled/glm-5.3"));
});

test("honors provider preference inside the same availability tier", () => {
  const models = [
    model("primary", "glm-5.3", "GLM 5.3"),
    model("cheap-plan", "glm-5.3", "GLM 5.3"),
    model("payg", "glm-5.3", "GLM 5.3"),
  ];
  const usage = {
    reports: [
      { provider: "cheap-plan", limits: [{ amount: { remainingFraction: 0.4 } }] },
      { provider: "payg", limits: [{ amount: { remainingFraction: 0.9 } }] },
    ],
  };
  const plan = buildFallbackPlan(models, usage, {
    providerOrder: ["cheap-plan", "payg"],
  });

  assert.deepEqual(plan.fallbackChains["primary/glm-5.3"], [
    "cheap-plan/glm-5.3",
    "payg/glm-5.3",
  ]);
});

test("creates an OMP overlay without changing unrelated settings", () => {
  const overlay = createOverlay({
    fallbackChains: {
      "provider-a/glm-5.3": ["provider-b/glm-5.3"],
    },
  });

  assert.deepEqual(overlay, {
    retry: {
      enabled: true,
      modelFallback: true,
      fallbackRevertPolicy: "cooldown-expiry",
      fallbackChains: {
        "provider-a/glm-5.3": ["provider-b/glm-5.3"],
      },
    },
  });
});
