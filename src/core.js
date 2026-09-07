const CLAUDE_FAMILIES = new Set(["fable", "haiku", "mythos", "opus", "sonnet"]);
const THINKING_PROFILES = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

const normalizeVersion = (major, minor) => minor ? `${Number(major)}.${Number(minor)}` : `${Number(major)}`;

const parseClaudeName = (name) => {
  const match = String(name ?? "").match(/\bclaude\s+(fable|haiku|mythos|opus|sonnet)\s+(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    family: `claude-${match[1].toLowerCase()}`,
    version: normalizeVersion(match[2], match[3]),
  };
};

const parseClaudeId = (id) => {
  const match = String(id ?? "").toLowerCase().match(/(?:^|\/)claude-(fable|haiku|mythos|opus|sonnet)-(\d+)(?:[-.](\d+))?/);
  if (!match || !CLAUDE_FAMILIES.has(match[1])) return null;
  return {
    family: `claude-${match[1]}`,
    version: normalizeVersion(match[2], match[3]),
  };
};

const parseProfile = (id) => {
  const suffix = String(id ?? "").toLowerCase().match(/-([a-z]+)$/)?.[1];
  return THINKING_PROFILES.has(suffix) ? suffix : null;
};

export const canonicalizeModel = (model) => {
  const id = String(model?.id ?? "");
  const name = String(model?.name ?? "");
  const normalizedId = id.toLowerCase().replace(/^~/, "");
  const base = {
    ...model,
    provider: String(model?.provider ?? ""),
    id,
    selector: model?.selector ?? `${model?.provider ?? ""}/${id}`,
    profile: parseProfile(id),
  };

  if (/:batch$/i.test(id) || /\(batch\)/i.test(name)) {
    return {
      ...base,
      canonicalKey: null,
      confidence: "none",
      routeEligible: false,
      exclusionReason: "non-interactive-variant",
    };
  }

  if (/(?:^|[-/])latest$/i.test(normalizedId) || /\blatest\b/i.test(name)) {
    return {
      ...base,
      canonicalKey: null,
      confidence: "none",
      routeEligible: false,
      exclusionReason: "ambiguous-latest-alias",
    };
  }

  const fromName = parseClaudeName(name);
  const fromId = parseClaudeId(normalizedId);
  if (fromName || fromId) {
    const identity = fromName ?? fromId;
    const agrees = !fromName || !fromId
      || (fromName.family === fromId.family && fromName.version === fromId.version);
    if (!agrees) {
      return {
        ...base,
        canonicalKey: null,
        confidence: "none",
        routeEligible: false,
        exclusionReason: "conflicting-model-identity",
      };
    }
    return {
      ...base,
      canonicalKey: `${identity.family}@${identity.version}`,
      confidence: fromName && fromId ? "high" : "medium",
      routeEligible: true,
      exclusionReason: null,
    };
  }

  const exactId = normalizedId.split("/").at(-1)?.trim();
  if (!exactId) {
    return {
      ...base,
      canonicalKey: null,
      confidence: "none",
      routeEligible: false,
      exclusionReason: "missing-model-id",
    };
  }

  return {
    ...base,
    canonicalKey: `exact:${exactId}`,
    confidence: "exact-id",
    routeEligible: true,
    exclusionReason: null,
  };
};

export const groupEquivalentModels = (models) => {
  const grouped = new Map();
  for (const rawModel of models ?? []) {
    const model = canonicalizeModel(rawModel);
    if (!model.routeEligible) continue;
    const group = grouped.get(model.canonicalKey) ?? [];
    group.push(model);
    grouped.set(model.canonicalKey, group);
  }

  return [...grouped.entries()]
    .filter(([, entries]) => new Set(entries.map((entry) => entry.provider)).size > 1)
    .map(([canonicalKey, entries]) => ({
      canonicalKey,
      models: entries.sort((left, right) => left.selector.localeCompare(right.selector)),
    }))
    .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey));
};

const readRemainingFraction = (amount) => {
  if (Number.isFinite(amount?.remainingFraction)) return amount.remainingFraction;
  if (Number.isFinite(amount?.usedFraction)) return 1 - amount.usedFraction;
  if (Number.isFinite(amount?.remaining) && Number.isFinite(amount?.limit) && amount.limit > 0) {
    return amount.remaining / amount.limit;
  }
  return null;
};

const ensureSignal = (signals, provider) => {
  signals[provider] ??= {
    disabled: false,
    quotaKnown: false,
    remainingFraction: null,
  };
  return signals[provider];
};

export const summarizeProviderUsage = (usage = {}) => {
  const signals = {};
  for (const report of usage.reports ?? []) {
    if (!report?.provider) continue;
    const signal = ensureSignal(signals, report.provider);
    const fractions = (report.limits ?? [])
      .map((limit) => readRemainingFraction(limit?.amount))
      .filter(Number.isFinite)
      .map((fraction) => Math.max(0, Math.min(1, fraction)));
    if (fractions.length > 0) {
      signal.quotaKnown = true;
      signal.remainingFraction = Math.min(...fractions);
    }
  }

  for (const [provider, entries] of Object.entries(usage.capacity ?? {})) {
    const fractions = (entries ?? [])
      .map((entry) => {
        if (Number.isFinite(entry?.remainingAccounts) && Number.isFinite(entry?.accounts) && entry.accounts > 0) {
          return entry.remainingAccounts / entry.accounts;
        }
        return null;
      })
      .filter(Number.isFinite)
      .map((fraction) => Math.max(0, Math.min(1, fraction)));
    if (fractions.length === 0) continue;
    const signal = ensureSignal(signals, provider);
    const remaining = Math.min(...fractions);
    signal.quotaKnown = true;
    signal.remainingFraction = signal.remainingFraction === null
      ? remaining
      : Math.min(signal.remainingFraction, remaining);
  }

  for (const entry of usage.disabledCredentials ?? []) {
    const provider = typeof entry === "string" ? entry : entry?.provider;
    if (!provider) continue;
    ensureSignal(signals, provider).disabled = true;
  }

  return signals;
};

const availabilityTier = (signal) => {
  if (signal?.disabled) return -1;
  if (!signal?.quotaKnown) return 2;
  if (signal.remainingFraction > 0.05) return 3;
  if (signal.remainingFraction > 0) return 1;
  return 0;
};

const supportsSource = (source, target) => {
  if (source.reasoning && target.reasoning === false) return false;
  if (Number.isFinite(source.contextWindow) && Number.isFinite(target.contextWindow)
    && target.contextWindow < source.contextWindow) return false;
  const targetInputs = new Set(target.input ?? []);
  return (source.input ?? []).every((input) => targetInputs.has(input));
};

const chooseProviderModel = (source, models, defaultProfile) => {
  const compatible = models.filter((target) => supportsSource(source, target));
  if (compatible.length === 0) return null;
  if (source.profile) {
    const sameProfile = compatible.find((target) => target.profile === source.profile);
    if (sameProfile) return sameProfile;
    const configurable = compatible.find((target) => !target.profile && (target.thinking ?? []).includes(source.profile));
    if (configurable) return configurable;
  }
  return compatible.find((target) => target.profile === defaultProfile)
    ?? compatible.find((target) => !target.profile)
    ?? compatible[0];
};

const selectorForSource = (source, target) => {
  if (!source.profile || target.profile) return target.selector;
  if (!(target.thinking ?? []).includes(source.profile)) return target.selector;
  return `${target.selector}:${source.profile}`;
};

const rankProviderChoices = (choices, signals, providerOrder) => {
  const preference = new Map(providerOrder.map((provider, index) => [provider, index]));
  return choices
    .filter((choice) => !signals[choice.model.provider]?.disabled)
    .sort((left, right) => {
      const leftSignal = signals[left.model.provider];
      const rightSignal = signals[right.model.provider];
      const tierDifference = availabilityTier(rightSignal) - availabilityTier(leftSignal);
      if (tierDifference !== 0) return tierDifference;
      const leftPreference = preference.get(left.model.provider) ?? Number.MAX_SAFE_INTEGER;
      const rightPreference = preference.get(right.model.provider) ?? Number.MAX_SAFE_INTEGER;
      if (leftPreference !== rightPreference) return leftPreference - rightPreference;
      const leftRemaining = leftSignal?.remainingFraction ?? -1;
      const rightRemaining = rightSignal?.remainingFraction ?? -1;
      if (leftRemaining !== rightRemaining) return rightRemaining - leftRemaining;
      return left.model.provider.localeCompare(right.model.provider);
    });
};

const explainChoice = (choice, signal, providerOrder) => {
  const reasons = [];
  const preference = providerOrder.indexOf(choice.model.provider);
  if (preference >= 0) reasons.push(`preference #${preference + 1}`);
  if (!signal?.quotaKnown) reasons.push("quota unknown");
  else if (signal.remainingFraction === 0) reasons.push("quota exhausted");
  else reasons.push(`${Math.round(signal.remainingFraction * 100)}% quota remaining`);
  if (choice.model.profile) reasons.push(`profile ${choice.model.profile}`);
  return reasons;
};

export const buildFallbackPlan = (models, usage = {}, options = {}) => {
  const providerOrder = options.providerOrder ?? [];
  const defaultProfile = options.defaultProfile ?? "high";
  const signals = summarizeProviderUsage(usage);
  const fallbackChains = {};
  const routes = [];

  for (const group of groupEquivalentModels(models)) {
    const byProvider = Map.groupBy(group.models, (model) => model.provider);
    for (const source of group.models) {
      const choices = [];
      for (const [provider, providerModels] of byProvider) {
        if (provider === source.provider) continue;
        const target = chooseProviderModel(source, providerModels, defaultProfile);
        if (target) choices.push({ model: target, selector: selectorForSource(source, target) });
      }
      const ranked = rankProviderChoices(choices, signals, providerOrder);
      if (ranked.length === 0) continue;
      fallbackChains[source.selector] = ranked.map((choice) => choice.selector);
      routes.push({
        canonicalKey: group.canonicalKey,
        source: source.selector,
        fallbacks: ranked.map((choice) => ({
          provider: choice.model.provider,
          selector: choice.selector,
          reasons: explainChoice(choice, signals[choice.model.provider], providerOrder),
        })),
      });
    }
  }

  return { fallbackChains, routes, signals };
};

export const createOverlay = (plan) => ({
  retry: {
    enabled: true,
    modelFallback: true,
    fallbackRevertPolicy: "cooldown-expiry",
    fallbackChains: plan.fallbackChains,
  },
});
