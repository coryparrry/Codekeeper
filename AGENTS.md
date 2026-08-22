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
Before editing runtime, installer, workflow, packaging, generated, or release paths, follow [docs/AGENT_RELEASE_SAFETY.md](docs/AGENT_RELEASE_SAFETY.md). It is the agent-facing impact map and boundary-specific verification contract.
Release packs bind the exact Git commit of a clean `HEAD`. Candidate packs bind
the explicitly supplied candidate commit. Ancestry alone is insufficient, so
verify the exact checkpoint before publication.

### Release evidence and verification

- A check proves only the boundary it exercises. Source tests do not prove generated assets, packaged files, workflows, live GitHub settings, npm publication, or an adopter installation.
- Before editing, record the branch, commit, and working-tree state. Trace each changed source through every generated, copied, packaged, installed, and executed consumer identified by the release-safety impact map.
- Bind evidence to the exact state tested. If `HEAD`, dependencies, generated output, package contents, or relevant external state changes, rerun the affected verification.
- Run verification appropriate to every touched surface, synchronize derived outputs only after source changes are complete, and never hand-edit generated manifests or hashes.
- Treat unavailable credentials, runners, billing, networks, or services as evidence gaps—not product passes or failures. Report exact commands, results, commit SHA, and any live boundaries that remain unverified.

### Generated hashes and source pins

Treat hashes, manifests, and package source commits as dependent outputs, never as values to guess or update early.

1. Finish the source change first. If runtime payload files changed, run `node tools/codekeeper/scripts/generate-tooling-manifest.mjs --write`, then its `--check` form, before committing the source change.
2. Run the affected tests and commit all source changes except the root manifest. Do not commit generated `packages/codekeeper/assets/metadata.json` or copied caller workflows; they are produced at pack time.
3. From that clean commit, run `node scripts/refresh-release-manifest.mjs`. It computes and commits only `MANIFEST.sha256`, which is compatibility-only for remaining source-pinned installations; never hand-edit that file. If any tracked file changes afterward, repeat this final step.
4. Verify the final clean commit with `bash scripts/release-source.sh --verify` and report the exact commit SHA that passed.

Never record a future, unmerged, or self-referential commit. Run `node scripts/sync-policy-validator.mjs --write` when the installer policy-validator copy must match `tools/codekeeper/src/lib/policy-validator.mjs`, then rerun the manifest sequence above. Do not hand-edit a source-commit constant.

## Generic Product Boundary

Keep this repository generic and adopter-safe. Do not commit organization-specific runner labels, billing settings, repository names, fixture credentials, user identities, or other deployment-local values to product workflows, examples, policies, or tests. Put concrete CI runner choices in repository or organization settings behind a generic variable with a portable default. Put live acceptance-only configuration in the private acceptance repository. Any exception requires explicit product-level justification and a contract test proving it is not personal configuration.
