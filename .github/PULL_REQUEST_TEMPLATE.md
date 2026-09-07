<!--
Conventional commit prefixes drive releases: feat: / fix: / docs: / chore: / refactor: / test:
Use one in the PR title.
-->

## What changes

<!-- One or two sentences. -->

## Why

<!-- The routing situation that is wrong or missing today. -->

## Routing impact

<!-- Delete the rows that do not apply. -->

| Question | Answer |
| --- | --- |
| Can this produce a route that did not exist before? | |
| Can this reorder an existing chain? | |
| Can this drop a candidate that used to be routable? | |
| Does the generated overlay shape change? | |

## Verification

```console
$ npm test
```

- [ ] `npm test` passes locally
- [ ] `omp-route plan` / `explain` output was inspected by hand for an affected model family
- [ ] Conservative by default: no new match relies on name similarity alone
- [ ] Still zero runtime dependencies
