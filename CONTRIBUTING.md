# Contributing to Codekeeper

Thank you for improving Codekeeper. It controls repository automation, so a
small change can affect an authority boundary.

## Before you start

- Read [ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [CONFIGURATION.md](docs/CONFIGURATION.md), and [SECURITY.md](SECURITY.md).
- Use a focused branch and preserve unrelated working-tree changes.
- Do not add live credentials, private traces, organisation-specific runner
  labels, repository names, or billing configuration.
- Open a discussion or issue for a capability change that changes trust,
  provider data, GitHub permissions, or the supported surface.

## Make and test the change

Use two-space ESM style with double quotes and trailing commas. Add an
observable regression test for failure, stale-state, or authority behavior when
the change affects it.

Run the smallest relevant test first, then the affected package checks. Common
commands are:

```bash
npm run check
node tools/codekeeper/src/cli.mjs check-config
cd tools/codekeeper && npm run check
cd ../../packages/codekeeper && npm run check
cd ../../acceptance && npm run check
```

Runtime or workflow changes also need the generated tooling manifest, embedded
assets, workflow pins, and release integrity inputs kept in sync. Do not claim
a public release, live adopter proof, or provider benchmark from local tests.

## Pull requests

Use a focused Conventional Commit, such as `fix(review): preserve human labels`.
Explain user-visible behavior, authority effects, exact tests run, and any live
validation not performed. Keep a PR below 3,000 changed lines; use a stacked
series for a larger change.

Use [SUPPORT.md](SUPPORT.md) for support and security-reporting routes. By
participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
