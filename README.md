# omp-route

Automatic provider fallback configuration for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP).

OMP already supports runtime fallback via `retry.fallbackChains`, but you have to
author every chain by hand — and provider-specific model IDs
(`cctq-claude/claude-fable-5` vs `openrouter/anthropic/claude-fable-5`) make that
tedious. `omp-route` fills the gap: it scans your configured models, detects
equivalent models across providers, ranks candidates, and generates an OMP config
overlay so a quota-exhausted provider automatically falls back to the next one.

**Status: proof of concept.** It does not proxy requests, store credentials, or
reimplement OMP's retry logic — it only compiles a config overlay and launches
OMP with it.

## Requirements

- Node.js >= 22
- [OMP](https://github.com/can1357/oh-my-pi) installed and on `PATH`
  (or set `OMP_ROUTE_OMP_COMMAND` to its executable)

## Install

```sh
git clone https://github.com/Nigmat-future/omp-route.git
cd omp-route
npm install -g .
```

Or run directly without installing:

```sh
node bin/omp-route.js --help
```

## Usage

```text
omp-route scan [query]                                    List cross-provider equivalent models
omp-route plan [--match query] [--prefer a,b]             Preview generated fallback chains
omp-route explain [query] [--prefer a,b]                  Explain route ordering
omp-route run [--match query] [--prefer a,b] [-- OMP...]  Write overlay and launch OMP
```

Typical flow:

```sh
# 1. See which models exist on more than one provider
omp-route scan fable

# 2. Preview the chains that would be generated
omp-route plan --match fable --prefer cursor,cctq-claude,openrouter

# 3. Explain why a route is ordered the way it is
omp-route explain cctq-claude/claude-fable-5

# 4. Launch OMP with the generated overlay
omp-route run --match fable --prefer cursor,cctq-claude,openrouter -- --model fable
```

`run` writes `~/.omp-route/routes.generated.yml` (JSON-formatted YAML overlay,
mode `0600`) containing `retry.fallbackChains`, then launches
`omp --config <overlay> <your args>` with stdio inherited. Your real OMP config
is never modified.

## How it works

1. `omp models --json` provides the model catalog; `omp usage --json --redact`
   provides quota state (best-effort — routing still works without it).
2. Models are canonicalized conservatively: `claude-fable-5` and
   `claude-fable-5.1` stay in separate groups, `latest` aliases and batch-only
   variants are excluded, and thinking/profile suffixes like `-high` are kept
   compatible rather than merged blindly.
3. Candidates are ranked by remaining quota (when known), then by your
   `--prefer` order.
4. A chain is generated for every selectable variant in each multi-provider
   group, so whichever model you start on has a fallback path.
5. OMP handles the actual retries, cooldowns, and fallback reverts at runtime.

## Safety

- Never reads or copies credentials; OMP's own `--redact` output is used and
  error text is additionally scrubbed for `sk-…`/`Bearer …` patterns.
- Refuses to generate unscoped overlays with more than 200 routes
  (`--all` overrides).
- Fails closed on malformed OMP output.

## Limitations

- Routes are planned at launch time; there is no live success-rate or latency
  feedback, and a request already mid-stream cannot be migrated — fallback
  applies to subsequent turns/retries handled by OMP.
- Model equivalence is heuristic; verify `plan` output before trusting a group.

## Development

```sh
npm test    # node --test — unit, CLI, and fake-OMP integration tests
```

Environment variables: `OMP_ROUTE_OMP_COMMAND` (OMP executable override),
`OMP_ROUTE_DIR` (overlay output directory).

## License

[MIT](LICENSE)
