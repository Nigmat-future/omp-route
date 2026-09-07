# Security Policy

`omp-route` is a local planning tool. It reads OMP's model catalog and a redacted
usage report, writes a configuration overlay, and launches the OMP binary. It never
contacts model-provider APIs and never proxies model traffic.

## Threat model

What the tool is designed to guarantee:

| Property | Mechanism |
| --- | --- |
| No credential access | Usage is requested with OMP's `--redact` flag; error output is additionally scrubbed for API-key and bearer-token patterns before it is printed |
| No network egress | The planner only spawns the locally installed OMP CLI; there are no HTTP clients and no runtime dependencies |
| No shell injection | OMP is spawned without a shell, and passthrough arguments are forwarded as an array |
| Reversible writes | The overlay is written to its own file (`~/.omp-route/routes.generated.yml`, mode `0600` where supported); the user's OMP configuration is never edited |
| Fail closed | Invalid model-discovery JSON aborts before OMP is launched |
| Bounded automation | Unscoped plans above 200 routes are refused unless `--all` is passed |

Out of scope: the behavior of OMP itself, the model providers it talks to, and the
correctness of a route once OMP has taken over execution.

## Supported versions

`omp-route` is a proof of concept. Only the `main` branch receives fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Nigmat-future/omp-route/security/advisories/new)
rather than in a public issue.

Useful details: the command you ran, the OMP version, the generated overlay (with
any provider identifiers you consider sensitive removed), and what you expected
instead. A response can be expected within 14 days.

If the issue is a leak of secrets into output, please include the redaction path
that failed — that code lives in `src/omp.js`.
