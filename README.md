# Codekeeper

Codekeeper is a set of **versioned reusable GitHub Actions workflows** for one repository at a time. It uses four independently configured agent roles to review pull requests, triage issues, audit the default branch, and implement explicitly enabled fixes.

It is not a hosted service, webhook receiver, or multi-tenant GitHub App. The release builder now stages the CLI, TUI, production runtime, agents, integrations, reusable workflows, and their exact dependencies as one closed [`codekeeper` package](packages/codekeeper/README.md). The package remains unpublished while workflow migration and private acceptance are in progress, so current adopter workflows still execute the compatibility runtime pinned to an immutable repository commit. The CLI does not copy runtime source or dependencies into adopter repositories. Each adopter owns its GitHub App credentials and policy.

## What adopters install

| Reusable workflow | Caller responsibility |
|---|---|
| `codekeeper-review.yml` | Review eligible pull requests and expose a fail-closed review gate. |
| `codekeeper-maintain.yml` | Audit the default branch. A live run may create one bounded repair when repository repair is on. |
| `codekeeper-issues.yml` | Triage opened, reopened, or edited issues while `auto_triage=true`; configured-owner `/codekeeper triage` comments remain available when automatic triage is off. |
| `codekeeper-fix.yml` | Implement an issue that trusted triage marks ready when issue implementation is on. A configured owner can also request exactly `/codekeeper fix` on an existing pull request. |
| `codekeeper-assistant.yml` | Always-installed, lightweight owner-request router for issue and pull-request comments; it routes only actions whose role caller is installed. |

The guided installer performs this generation from release-pinned assets. Until it is published, use a locally built installer tarball for private acceptance or follow the [manual installation guide](INSTALL.md). The generated setup includes [`.github/codekeeper.json`](.github/codekeeper.json) and the selected callers. Agent profiles come from the pinned runtime by default; an adopter file under `.github/codekeeper/agents/` exists only when a maintainer opts into a repository-specific override. The manual path copies the matching non-executable templates from [`examples/workflows`](examples/workflows), replaces `OWNER/REPOSITORY` and `FULL_COMMIT_SHA`, and copies the policy into the adopter's default branch. Each caller pins the direct Codekeeper bootstrap action and its reusable workflow to the same immutable commit. The action stages only the production `tools/codekeeper` payload as a one-day artifact; every reusable job verifies that payload against the source-controlled manifest before using it. Adopters do not copy `tools/codekeeper` or source workflow files, and do not provide a source-repository token.

The root policy is a valid starter, not a safe default for every repository. Before enabling it, replace `repository.ownerLogins`, verify the default branch and automation prefix, and tailor repair, validation, and auto-merge paths. Each mode has its own `ai.agents.<mode>` provider, model, settings, and optional Codex workspace specialist. The runtime label names are intentionally namespaced and must remain defined exactly as supplied. See [configuration](docs/CONFIGURATION.md).

Each coordinator role can use OpenAI, DeepSeek, OpenRouter, or an arbitrary model ID for one of those providers. The coordinator choice is independent from its optional OpenAI Codex workspace specialist.

## Agent roles and authority

| Role | Trigger | What it does | Actions it can take |
|---|---|---|---|
| Pull request reviewer | A PR event, review comment, or `/codekeeper review` | Maintains one living summary, inventories the complete current review surface, deduplicates root causes, and classifies verified feedback as fix now, fix if cheap, defer, or ignore. | Updates review output and managed labels. A verified deferred item can become one fingerprinted issue; a current blocker can start the Fixer when automatic review repair is on. |
| Issue triager | An issue event or `/codekeeper triage` | Classifies the issue. Compares it with open issues and PRs that describe the same component, symptom, failure, or requested outcome. These are related items, not duplicates unless the failure and outcome match. | Updates one triage comment and managed labels. It closes an issue as completed when GitHub links a merged PR that resolves it, and can mark an issue ready or close an exact duplicate when those capabilities are on. |
| Repository auditor | A schedule or manual run | Reviews the default branch for evidence-backed maintenance work. | Creates maintenance issues. It can open one bounded repair PR when repository repair is on. |
| Fixer | A ready issue, `/codekeeper implement`, `/codekeeper fix`, or a validated automatic repair request | Proves the requested problem, chooses the smallest complete change, implements it, and runs focused validation in one workspace pass. | Opens one issue PR or pushes to the existing PR branch. It cannot bypass path, size, validation, or merge policy. |

The deterministic coordinator connects these roles. Pull request repair follows Reviewer → Fixer, and a Fixer push triggers the Reviewer again on the new PR head. The coordinator limits automatic repair to one pass and checks live GitHub state before each action.

Configured owners can use these exact commands:

- `/codekeeper status`
- `/codekeeper review`
- `/codekeeper rerun`
- `/codekeeper triage`
- `/codekeeper defer`
- `/codekeeper implement`
- `/codekeeper fix`
- `/codekeeper stop`

Configured owners can also use the exact mention form `@<app-slug> review`, substituting the installed App slug and one supported action. The entire comment must match that form; free-form requests such as `@<app-slug> please review this` are ignored. The always-installed assistant supplies the router, and each model-backed command requires its matching selected role workflow. Non-owner content and model output cannot grant mutation authority.

## Packaged coordinator profiles and adopter overrides

Each release has four fixed packaged Markdown defaults. Maintainers can optionally create normal reviewed repository overrides to change Codekeeper's evidence thresholds, prioritization, test expectations, duplicate criteria, no-action decisions, and reporting style without rebuilding the runtime.

| Coordinator | Optional override path | Packaged default |
|---|---|---|
| Pull request reviewer | `.github/codekeeper/agents/pr-reviewer.md` | [`tools/codekeeper/agents/pr-reviewer.md`](tools/codekeeper/agents/pr-reviewer.md) |
| Issue triager | `.github/codekeeper/agents/issue-triager.md` | [`tools/codekeeper/agents/issue-triager.md`](tools/codekeeper/agents/issue-triager.md) |
| Repository auditor | `.github/codekeeper/agents/repository-auditor.md` | [`tools/codekeeper/agents/repository-auditor.md`](tools/codekeeper/agents/repository-auditor.md) |
| Fixer | `.github/codekeeper/agents/fixer.md` | [`tools/codekeeper/agents/fixer.md`](tools/codekeeper/agents/fixer.md) |

Profiles tune priorities, work selection, implementation approach, review standards, and reporting. Capability switches control repair, issue implementation, issue closure, and merge actions. Profiles cannot enable a disabled capability, expand allowed paths, bypass protected paths or validation, change the target, expose credentials, or grant tools and network access.

Every run selects either the packaged default or the fixed override path from the trusted default-branch checkout, records explicit source provenance and SHA-256, and freezes the exact bytes used by the workspace and coordinator. Publication fails if that selected source has changed since preparation. Content from a pull-request branch, issue, comment, diff, or unrelated repository file is evidence only and cannot replace the selected profile. To change behavior, create or edit the relevant override in a normal pull request and merge it; later runs use the new default-branch version.

## Security model

- Codex runs in a workspace-only job with no model, trace, or GitHub App credential. A fresh coordinator job receives model and optional trace credentials, rebuilds trusted context, and treats the specialist artifact as untrusted evidence.
- Every Codex workspace uses a fresh runner-owned home with repository project documents disabled. Repository `.agents/skills` and `.codex/skills` are quarantined for the model run and restored before patch capture.
- The GitHub App write token exists only in publication; verification and sealing remain credential-free.
- A direct action at the caller's pinned source revision uses GitHub's private-action access to stage the production runtime as a one-day artifact. Every reusable job verifies the source-pinned manifest, exact inventory, hashes, and absence of symlinks or hidden paths before it runs Codekeeper. Adopter policy is read only from its default branch.
- The selected agent profile is loaded from either the verified package or its fixed adopter override path, frozen into the run artifact with source provenance, and checked for drift before publication.
- The review caller is a default-branch `pull_request_target` definition: it only invokes the reusable workflow and never checks out or executes PR code.
- Event fields, issue text, comments, repository files, and model output are treated as untrusted data. Frozen workflow context is embedded in the model prompt.
- Candidate output is structurally validated, copied into a sealed artifact, and published only by a later App-token job. Repository code is never executed in that publishing job.
- Repair patches are checked again in a fresh credential-free checkout before sealing and publication.
- Review labels, sticky comments, issue fingerprints, repair PRs, and same-PR repair commits trust only the configured GitHub App bot identity.
- Auto-merge remains opt-in and is independently limited by author, branch, risk, tests, paths, files, changed lines, and complete frozen diff context.
- Agents SDK tracing is enabled by the starter policy with `includeSensitiveData=false`. OpenAI remains the default exporter and requires a separate `trace_api_key`; the review caller can instead select the isolated Braintrust exporter with `CODEKEEPER_TRACE_EXPORTER=braintrust` and a dedicated `BRAINTRUST_API_KEY`.

See [the architecture](docs/ARCHITECTURE.md) and [installation guide](INSTALL.md) for the exact boundaries.

## Supported surface and limits

This release is **GitHub.com only**. It relies on reusable-workflow identity fields that are unavailable on GitHub Enterprise Server.

- Review supports non-draft, same-repository pull requests targeting the repository default branch. Forks, drafts, disabled runs, and non-default-branch targets fail the review gate closed.
- The supplied review caller does not subscribe to `merge_group`; do not make its gate required for merge queues.
- The review caller controls automatic PR review with `auto_review` (default `true`); setting it to `false` skips review and causes the required review gate to fail closed.
- The issue caller controls automatic issue triage with `auto_triage` (default `true`). Automatic triage is limited to opened, reopened, and edited issue events. It may publish labels and a sticky comment. When `issues.closeResolvedIssues=true`, it closes an issue as completed only after GitHub identifies a merged PR as a closing reference. Exact duplicate closure remains separately controlled by default-false `issues.closeExactDuplicates`.
- A maintenance dry run is report-only. A live maintenance run may create one bounded repair when `audit.repair.enabled=true`.
- When `issues.allowAiImplementation=true`, trusted triage adds `ready` to a clear, bounded issue and starts its implementation workflow.
- Configured-owner `/codekeeper triage` and `/codekeeper fix` comments require an `OWNER`, `MEMBER`, or `COLLABORATOR` association plus a GitHub login in `repository.ownerLogins`. The fix command must be the complete comment body. Manual fix dispatch also requires a configured owner.
- An issue fix may open a bounded repair pull request. A fix requested on an eligible same-repository pull request instead commits to that pull request's existing head branch; it never opens a second pull request and has no create-new-PR fallback. Fork pull requests, drafts, protected/default head branches, stale heads, and unsupported targets fail closed.

Treebar-specific paths and policy are kept only as an optional [example](examples/treebar/README.md); they are not runtime defaults.

## Local verification

```bash
env npm_config_cache=/tmp/codekeeper-npm-cache npm ci --ignore-scripts --no-audit --no-fund
npm run check
node tools/codekeeper/src/cli.mjs check-config
cd tools/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
```

The package pins its Agents SDK dependencies and requires Node.js 22 or newer locally. The reusable workflows pin Node.js, npm dependencies, and the optional Codex CLI themselves. See [evaluating Codekeeper reviews](docs/EVALUATIONS.md) for synthetic gates, Braintrust traces, repeated live GitHub runs, answer-key isolation, and aggregate scoring.

## Source releases

Source releases are built only from a clean, immutable Git commit. The release command archives tracked content, verifies the unpacked manifest and inventory, and prints the archive checksum:

```bash
mkdir -p ../codekeeper-release-artifacts
bash scripts/release-source.sh --output ../codekeeper-release-artifacts
```

See [validation](VALIDATION.md#source-release-integrity) for the clean-tree requirement, verification-only command, and the boundary between source integrity and GitHub release visibility.

## Acknowledgements

Codekeeper's command routing, bounded repair loop, status comment, related-item context, and maintainer-decision design were inspired by [ClawSweeper](https://github.com/openclaw/clawsweeper).

No ClawSweeper source code is included. Codekeeper is an independent implementation, so the ClawSweeper MIT license is not bundled.
