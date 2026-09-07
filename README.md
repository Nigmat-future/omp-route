<p align="center"><code>OMP ROUTING PLAN COMPILER</code></p>

<h1 align="center">omp-route</h1>

<p align="center">
  <strong>Keep the task moving when a provider stops.</strong><br />
  Discover equivalent models, rank available providers, and compile safe fallback chains for Oh My Pi.
</p>

<p align="center">
  <a href="https://github.com/Nigmat-future/omp-route/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827?style=flat-square"></a>
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A522-111827?style=flat-square">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/runtime_dependencies-0-111827?style=flat-square">
  <img alt="Proof of concept" src="https://img.shields.io/badge/status-proof_of_concept-B45309?style=flat-square">
</p>

<p align="center">
  <a href="#why-omp-route">Why</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#command-reference">Reference</a> ·
  <a href="#safety-model">Safety</a>
</p>

```text
$ omp-route explain cctq-claude/claude-fable-5

Generated 1 fallback route.

source: cctq-claude/claude-fable-5 (claude-fable@5)
  1. cursor/claude-fable-5-high — preference #1, 100% quota remaining, profile high
  2. glm-fireworks/anthropic/claude-fable-5 — preference #3, quota unknown
  3. openrouter/anthropic/claude-fable-5 — preference #5, quota unknown
```

> **OMP owns execution. `omp-route` only decides the order.** It is not a proxy and never sits between OMP and a model provider.

## Why omp-route

[Oh My Pi](https://github.com/can1357/oh-my-pi) already knows how to retry requests, cool down unhealthy providers, and follow `retry.fallbackChains`. What it cannot infer is that differently named selectors may represent the same model:

```text
cctq-claude/claude-fable-5
cursor/claude-fable-5-high
openrouter/anthropic/claude-fable-5
```

Without a chain, an exhausted provider still leaves you switching models by hand. `omp-route` supplies the missing planning layer.

| Manual setup | With `omp-route` |
| --- | --- |
| Find matching models provider by provider | Read the catalog directly from OMP |
| Compare provider-specific model IDs | Group conservative canonical equivalents |
| Hand-author every fallback chain | Generate a chain for every selectable variant |
| Reorder providers as quota changes | Rank from redacted usage data at launch |
| Modify the main OMP configuration | Write a separate, reversible overlay |

## Quick start

### Requirements

- [Node.js](https://nodejs.org/) 22 or newer
- [OMP](https://github.com/can1357/oh-my-pi) installed and available as `omp`

### Install from GitHub

`omp-route` is not published to the npm registry. Install it directly from this repository:

```sh
npm install --global github:Nigmat-future/omp-route
omp-route --help
```

Or clone and run it locally:

```sh
git clone https://github.com/Nigmat-future/omp-route.git
cd omp-route
node bin/omp-route.js --help
```

### Build your first route

```sh
# Inspect high-confidence cross-provider groups
omp-route scan fable

# Preview the exact fallback chains
omp-route plan --match fable --prefer cursor,cctq-claude,openrouter

# See why each candidate received its position
omp-route explain cctq-claude/claude-fable-5 \
  --prefer cursor,cctq-claude,openrouter

# Compile the overlay and launch OMP with your original arguments
omp-route run --match fable \
  --prefer cursor,cctq-claude,openrouter \
  -- --model fable
```

The last command writes `~/.omp-route/routes.generated.yml`, then starts:

```text
omp --config ~/.omp-route/routes.generated.yml --model fable
```

Your existing OMP configuration is not edited.

## How it works

```text
 omp models --json ─────────┐
                            ├── canonicalize ── compatibility gates ── rank
 omp usage --json --redact ─┘                                         │
                                                                      ▼
                                                         fallbackChains overlay
                                                                      │
                                                                      ▼
                                                            omp --config …
```

The planner runs once, immediately before OMP starts:

1. **Discover.** Read OMP's public model catalog and best-effort, redacted usage report.
2. **Canonicalize.** Normalize known provider-specific selectors without collapsing ambiguous versions.
3. **Gate.** Reject candidates that lose required reasoning support, context length, or input modalities.
4. **Rank.** Prefer usable quota tiers, then your provider preference within each tier.
5. **Compile.** Emit an explicit chain for every selectable model in every cross-provider group.
6. **Delegate.** Launch OMP and leave retries, cooldowns, and fallback reversion to its runtime.

If usage reporting is unavailable, planning continues from compatibility and `--prefer` instead of failing the task.

## Routing policy

The policy is intentionally conservative. A missed route is safer than silently replacing a model with the wrong one.

| Stage | Decision rule |
| --- | --- |
| Identity | Claude family and version are normalized explicitly; generic models require the same final model ID |
| Ambiguity | `latest` aliases, batch-only variants, conflicting identities, and missing IDs are excluded |
| Versioning | Fable 5 and Fable 5.1 remain separate canonical groups |
| Capability | A fallback must preserve reasoning support, context window, and every required input modality |
| Profile | Matching thinking profiles are preferred; configurable profiles are forwarded as selector suffixes |
| Availability | Known quota above 5% → unknown quota → low positive quota at 5% or below → exhausted |
| Preference | Inside one availability tier, `--prefer` order wins, followed by remaining quota and provider name |
| Disabled credentials | Removed from fallback candidates entirely |

### Generated overlay

The `.yml` file uses JSON syntax, which is valid YAML and unambiguous to serialize:

```json
{
  "retry": {
    "enabled": true,
    "modelFallback": true,
    "fallbackRevertPolicy": "cooldown-expiry",
    "fallbackChains": {
      "cctq-claude/claude-fable-5": [
        "cursor/claude-fable-5-high",
        "openrouter/anthropic/claude-fable-5"
      ]
    }
  }
}
```

Only retry settings are included in the overlay. Unrelated OMP settings remain untouched.

## Command reference

| Command | Purpose |
| --- | --- |
| `omp-route scan [query]` | List routable canonical groups spanning multiple providers |
| `omp-route plan [options]` | Preview all generated chains without writing a file |
| `omp-route explain [query] [options]` | Show ordering reasons for matching routes |
| `omp-route run [options] -- [OMP_ARGS...]` | Write the overlay and launch OMP with forwarded arguments |

| Option | Applies to | Description |
| --- | --- | --- |
| `--match <query>` | `plan`, `explain`, `run` | Limit discovery to matching canonical keys, selectors, or model names |
| `--prefer <a,b,...>` | `plan`, `explain`, `run` | Set provider priority within the same availability tier |
| `--profile <name>` | `plan`, `explain`, `run` | Preferred thinking profile when a source has no explicit profile; default is `high` |
| `--json` | `scan`, `plan`, `explain` | Print machine-readable output |
| `--all` | `run` | Allow an unscoped overlay even when it exceeds the automatic route guard |
| `--` | `run` | Forward every following argument to OMP unchanged |

For `run`, a passthrough `--model` value is also used as the route scope when `--match` is omitted.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Purpose |
| --- | --- |
| `OMP_ROUTE_DIR` | Override the directory containing `routes.generated.yml` |
| `OMP_ROUTE_OMP_COMMAND` | Override the OMP executable name or path |
| `OMP_ROUTE_OMP_PREFIX_ARGS` | JSON string array prepended to OMP arguments; mainly useful for wrappers and tests |

</details>

## Safety model

- **Local planning only.** The planner does not call model-provider APIs or proxy model traffic; it invokes the locally installed OMP CLI.
- **No credential access.** Usage is requested with OMP's `--redact` flag. Error output is additionally scrubbed for API-key and bearer-token patterns.
- **Reversible configuration.** The generated overlay is separate from the user's OMP config and requests file mode `0600` where supported.
- **Fail closed.** Invalid model-discovery JSON stops execution before OMP is launched.
- **Bounded automation.** Unscoped plans above 200 routes are refused unless the user passes `--all`.
- **Safe subprocess forwarding.** OMP is spawned without a shell and receives passthrough arguments as an array.

> [!IMPORTANT]
> `omp-route` is a proof of concept. Review `plan` output before relying on a new model family in unattended workloads.

## Boundaries

`omp-route` deliberately does not:

- proxy, stream, or issue model-generation requests;
- migrate a request that is already mid-stream;
- continuously re-plan routes during a running OMP session;
- guarantee semantic equivalence for arbitrary or ambiguous model names;
- replace OMP's retry classifier, cooldown handling, or runtime fallback logic.

A real transition still depends on OMP classifying the provider response as retryable and on the provider returning a recognizable quota or availability error.

## Development

```sh
git clone https://github.com/Nigmat-future/omp-route.git
cd omp-route
npm test
```

The suite uses Node's built-in test runner and covers canonicalization, compatibility, quota ranking, CLI behavior, overlay generation, argument forwarding, degraded usage reporting, and malformed discovery output. There are no runtime dependencies.

Issues and focused pull requests are welcome.

## License

Released under the [MIT License](LICENSE).
