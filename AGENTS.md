# Repository Guidelines

## Project Structure & Module Organization

Codekeeper is a Node.js 22+ ES-module repository. `tools/codekeeper/` contains the provider-configurable maintainer runtime, policies, evaluation harness, and runtime tests. `packages/codekeeper/` contains the distributable installer CLI, embedded workflow assets, and installer tests. Reusable GitHub workflows live in `.github/workflows/`; adopter-facing caller templates live in `examples/workflows/`. `acceptance/` is the offline end-to-end harness. Architecture, configuration, validation, and security guidance live in `docs/`, `VALIDATION.md`, and `SECURITY.md`.

## Build, Test, and Development Commands

- `npm ci && npm run check` — install root tooling, then run ESLint and Prettier checks.
- `node tools/codekeeper/src/cli.mjs check-config` — validate repository policy and configuration.
- `cd tools/codekeeper && npm ci && npm run check` — syntax-check the runtime, verify its generated tooling manifest, and run runtime tests.
- `cd packages/codekeeper && npm ci && npm run check` — validate the installer package and test its CLI/assets.
- `cd acceptance && npm run check` — run the deterministic offline acceptance fixture.
- `bash scripts/release-source.sh --verify` — verify tracked-file inventory and `MANIFEST.sha256` before release work.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, trailing commas, and `.mjs` ES modules. Prefer `camelCase` for functions and variables, `PascalCase` for components/classes, and descriptive kebab-case filenames where a module is not named for one exported type. Run `npm run check`; do not hand-format generated manifests or installer metadata.

## Testing Guidelines

Tests use `node:test` with strict assertions and live beside each subsystem under `test/*.test.mjs`. Name tests after observable behavior, including failure, stale-state, timeout, and trust-boundary cases. Run the narrow suite while developing, then every affected package check. Runtime or workflow changes must keep `tools/codekeeper/tooling-manifest.json`, embedded assets, workflow pins, and release integrity synchronized.

## Commit & Pull Request Guidelines

Follow the repository’s Conventional Commit history: `fix(review): ...`, `feat(assistant): ...`, `test(review): ...`, or `chore(release): ...`. Keep commits scoped to one root cause. PRs should lead with user-visible behavior, explain security or authority-boundary effects, link relevant issues, and list exact verification commands. Include screenshots for installer TUI changes and call out any unrun live or adopter-repository validation.

## Security & Agent Workflow

Never commit or paste provider keys, GitHub App PEMs, tokens, or live traces. Report vulnerabilities through GitHub private vulnerability reporting.
Release and source pins must be full, reviewed commits reachable from the repository default branch and containing the intended runtime; ancestry alone is insufficient, so verify the exact checkpoint before publication.

## Generic Product Boundary

Keep this repository generic and adopter-safe. Do not commit organization-specific runner labels, billing settings, repository names, fixture credentials, user identities, or other deployment-local values to product workflows, examples, policies, or tests. Put concrete CI runner choices in repository or organization settings behind a generic variable with a portable default. Put live acceptance-only configuration in the private acceptance repository. Any exception requires explicit product-level justification and a contract test proving it is not personal configuration.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
