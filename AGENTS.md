# Repository Guidelines

## Project Structure & Module Organization

Rivet is a Node.js 22+ ES-module repository. `packages/rivet/src/` contains the installer, guided CLI, App authority checks, workflow renderers, and pinned compiler integration. Managed workflow assets live in `packages/rivet/assets/`; package tests and evaluation commands live in `packages/rivet/test/` and `packages/rivet/evals/`. Repository CI and publication workflows live in `.github/workflows/`. Architecture, configuration, validation, and security guidance live in `docs/`, `VALIDATION.md`, and `SECURITY.md`. The old Codekeeper runtime, installer, and acceptance trees are retired.

## Build, Test, and Development Commands

- `npm ci --ignore-scripts --no-audit --no-fund && npm run check` — install root tooling and run package, lint, formatting, governance, architecture, and source-manifest checks.
- `npm run rivet:check` — install Rivet's dependencies and run its syntax and package tests.
- `npm --prefix packages/rivet run review-lock:check` — reproduce and validate managed workflows with the pinned compiler.
- `npm run architecture:check` — check module boundaries and local import cycles.
- `npm run governance:check` — validate checked-in repository governance and its tests.
- `bash scripts/release-source.sh --verify` — verify the tracked-file inventory and `MANIFEST.sha256` from a clean commit.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, trailing commas, and `.mjs` ES modules. Prefer `camelCase` for functions and variables, `PascalCase` for components/classes, and descriptive kebab-case filenames where a module is not named for one exported type. Run `npm run check`; do not hand-format generated manifests or installer metadata.

## Testing Guidelines

Tests use `node:test` with strict assertions and live beside each subsystem under `test/*.test.mjs`. Name tests after observable behavior, including failure, stale-state, timeout, and trust-boundary cases. Run the narrow suite while developing, then every affected package check. Runtime or workflow changes must keep managed assets, pinned compiler receipts, compiled workflow fixtures, and release integrity synchronized.

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

1. Finish the source change first. If workflow sources or compiler integration changed, reproduce and validate the affected compiled workflows with `npm --prefix packages/rivet run review-lock:check` and the boundary-specific checks in the release-safety contract.
2. Run the affected tests and commit all source changes except the root manifest. Do not add retired Codekeeper metadata or hand-edit compiler receipts, hashes, or source pins.
3. From that clean commit, run `node scripts/refresh-release-manifest.mjs`. It computes and commits only `MANIFEST.sha256`, which is compatibility-only for remaining source-pinned installations; never hand-edit that file. If any tracked file changes afterward, repeat this final step.
4. Verify the final clean commit with `bash scripts/release-source.sh --verify` and report the exact commit SHA that passed.

Never record a future, unmerged, or self-referential commit. Do not hand-edit a source-commit constant.

## Generic Product Boundary

Keep this repository generic and adopter-safe. Do not commit organization-specific runner labels, billing settings, repository names, fixture credentials, user identities, or other deployment-local values to product workflows, examples, policies, or tests. Put concrete CI runner choices in repository or organization settings behind a generic variable with a portable default. Put live acceptance-only configuration in an approved disposable acceptance repository. Public acceptance requires explicit authorization and nonsensitive fixture content. Any exception requires explicit product-level justification and a contract test proving it is not personal configuration.
