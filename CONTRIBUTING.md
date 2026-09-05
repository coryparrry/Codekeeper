# Contributing to Rivet

Thank you for improving Rivet. It installs repository automation, so a small
change can affect an authority boundary or an adopter's generated workflows.

## Before you start

- Read [ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [CONFIGURATION.md](docs/CONFIGURATION.md), [SECURITY.md](SECURITY.md), and
  [the agent release-safety contract](docs/AGENT_RELEASE_SAFETY.md).
- Use a focused branch and preserve unrelated working-tree changes.
- Do not add live credentials, private traces, organization-specific runner
  labels, repository names, or billing configuration.
- Open a discussion or issue before changing Rivet's trust boundary, provider
  data, GitHub permissions, or supported product surface.

## Make and test the change

Use two-space ES-module style with double quotes and trailing commas. Add an
observable regression test when a change affects failure, stale-state, upgrade,
or authority behavior.

Run the narrow test first, then the checks for every affected boundary. Common
commands are:

```bash
node --test packages/rivet/test/<focused-test>.test.mjs
npm run rivet:check
npm run architecture:check
npm run check
```

`npm run check` installs and tests `packages/rivet`, checks formatting and
linting, validates repository governance and module boundaries, and verifies
the source-release worktree. Follow
[the release-safety impact map](docs/AGENT_RELEASE_SAFETY.md#3-impact-map) for
workflow, package, generated, installed, and live-adopter verification.

Do not hand-edit generated workflow locks, package receipts, or
`MANIFEST.sha256`. Finish source changes first; release preparation refreshes
dependent outputs from the exact clean commit.

## Pull requests

Use a focused Conventional Commit, such as `fix(review): preserve human labels`.
Explain the user-visible behavior, authority effects, exact tests run, and any
live validation not performed. Keep changes reviewable and split independent
work into separate pull requests.

Use [SUPPORT.md](SUPPORT.md) for support and security-reporting routes. By
participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
