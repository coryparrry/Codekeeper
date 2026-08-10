# Codekeeper

Codekeeper is a set of **versioned reusable GitHub Actions workflows** for one repository at a time. It uses four independently configured Agents SDK coordinators to review same-repository pull requests, triage bounded issue lifecycle events or maintainer commands, audit the default branch, and implement explicitly enabled, bounded fixes.

It is not a hosted service, webhook receiver, or multi-tenant GitHub App. The private runtime is not delivered through npm. A separate dependency-light [`codekeeper` installer package](packages/codekeeper/README.md) generates pinned policy and caller files; it remains unpublished while private acceptance is in progress. Each adopter owns its GitHub App credentials and policy, and caller workflows pin this repository to an immutable release commit.

## What adopters install

| Reusable workflow | Caller responsibility |
|---|---|
| `codekeeper-review.yml` | Review eligible pull requests and expose a fail-closed review gate. |
| `codekeeper-maintain.yml` | Run report-only default-branch audits. A repair additionally requires an explicit, owner-authorized manual run. |
| `codekeeper-issues.yml` | Triage opened, reopened, or edited issues while `auto_triage=true`; configured-owner `/codekeeper triage` comments remain available when automatic triage is off. |
| `codekeeper-fix.yml` | Implement an issue or update an eligible same-repository pull request only after a configured owner requests exactly `/codekeeper fix` or uses manual dispatch. |

The guided installer performs this generation from release-pinned assets. Until it is published, use a locally built installer tarball for private acceptance or follow the [manual installation guide](INSTALL.md). The generated setup includes [`.github/codekeeper.json`](.github/codekeeper.json), the selected callers, and four adopter-owned Markdown profiles under `.github/codekeeper/agents/`. The manual path copies the matching non-executable templates from [`examples/workflows`](examples/workflows), replaces `OWNER/REPOSITORY` and `FULL_COMMIT_SHA`, and copies the policy and profiles into the adopter's default branch. Each caller pins the direct Codekeeper bootstrap action and its reusable workflow to the same immutable commit. The action stages only the production `tools/codekeeper` payload as a one-day artifact; every reusable job verifies that payload against the source-controlled manifest before using it. Adopters do not copy `tools/codekeeper` or source workflow files, and do not provide a source-repository token.

The root policy is a valid starter, not a safe default for every repository. Before enabling it, replace `repository.ownerLogins`, verify the default branch and automation prefix, and tailor repair, validation, and auto-merge paths. Each mode has its own `ai.agents.<mode>` provider, model, settings, and optional Codex workspace specialist. The runtime label names are intentionally namespaced and must remain defined exactly as supplied. See [configuration](docs/CONFIGURATION.md).

## Adopter-owned coordinator profiles

Each installation has four fixed Markdown files. They are normal reviewed repository files, so maintainers can change Codekeeper's evidence thresholds, prioritization, test expectations, duplicate criteria, no-action decisions, and reporting style without rebuilding the runtime.

| Coordinator | Installed path | Bundled seed |
|---|---|---|
| Pull request reviewer | `.github/codekeeper/agents/pr-reviewer.md` | [`tools/codekeeper/agents/pr-reviewer.md`](tools/codekeeper/agents/pr-reviewer.md) |
| Issue triager | `.github/codekeeper/agents/issue-triager.md` | [`tools/codekeeper/agents/issue-triager.md`](tools/codekeeper/agents/issue-triager.md) |
| Repository auditor | `.github/codekeeper/agents/repository-auditor.md` | [`tools/codekeeper/agents/repository-auditor.md`](tools/codekeeper/agents/repository-auditor.md) |
| Maintenance planner | `.github/codekeeper/agents/maintenance-planner.md` | [`tools/codekeeper/agents/maintenance-planner.md`](tools/codekeeper/agents/maintenance-planner.md) |

Profiles tune judgment, not permission. They cannot enable a workflow, authorize a repair or merge, expand allowed paths, bypass protected paths or validation, change the target, expose credentials, or grant tools and network access. Those boundaries remain in the caller, frozen policy, schemas, validators, and publication code.

Every run reads the applicable profile from the trusted default-branch checkout, records its source commit and SHA-256, and freezes the exact bytes used by the workspace and coordinator. Publication fails if the trusted profile has changed since preparation. Content from a pull-request branch, issue, comment, diff, or repository file is evidence only and cannot replace the trusted profile. To change behavior, edit the relevant installed Markdown file in a normal pull request and merge it; later runs use the new default-branch version.

## Security model

- Codex runs in a workspace-only job with no model, trace, or GitHub App credential. A fresh coordinator job receives model and optional trace credentials, rebuilds trusted context, and treats the specialist artifact as untrusted evidence.
- The GitHub App write token exists only in publication; verification and sealing remain credential-free.
- A direct action at the caller's pinned source revision uses GitHub's private-action access to stage the production runtime as a one-day artifact. Every reusable job verifies the source-pinned manifest, exact inventory, hashes, and absence of symlinks or hidden paths before it runs Codekeeper. Adopter policy is read only from its default branch.
- The selected adopter-owned agent profile is also read only from the default branch, frozen into the run artifact, and checked for drift before publication.
- The review caller is a default-branch `pull_request_target` definition: it only invokes the reusable workflow and never checks out or executes PR code.
- Event fields, issue text, comments, repository files, and model output are treated as untrusted data. Frozen workflow context is embedded in the model prompt.
- Candidate output is structurally validated, copied into a sealed artifact, and published only by a later App-token job. Repository code is never executed in that publishing job.
- Repair patches are checked again in a fresh credential-free checkout before sealing and publication.
- Review labels, sticky comments, issue fingerprints, repair PRs, and same-PR repair commits trust only the configured GitHub App bot identity.
- Auto-merge remains opt-in and is independently limited by author, branch, risk, tests, paths, files, changed lines, and complete frozen diff context.
- Agents SDK tracing is enabled by the starter policy with `includeSensitiveData=false`. It requires a separate OpenAI `trace_api_key` even when the selected model provider is DeepSeek; traces appear in [OpenAI Platform Traces](https://platform.openai.com/traces) under **Logs > Traces**.

See [the architecture](docs/ARCHITECTURE.md) and [installation guide](INSTALL.md) for the exact boundaries.

## Supported surface and limits

This release is **GitHub.com only**. It relies on reusable-workflow identity fields that are unavailable on GitHub Enterprise Server.

- Review supports non-draft, same-repository pull requests targeting the repository default branch. Forks, drafts, disabled runs, and non-default-branch targets fail the review gate closed.
- The supplied review caller does not subscribe to `merge_group`; do not make its gate required for merge queues.
- The review caller controls automatic PR review with `auto_review` (default `true`); setting it to `false` skips review and causes the required review gate to fail closed.
- The issue caller controls automatic issue triage with `auto_triage` (default `true`). Automatic triage is limited to opened, reopened, and edited issue events. It may publish labels, a sticky comment, and a duplicate candidate only; `issues.closeExactDuplicates` remains a separate default-`false` policy.
- Scheduled maintenance is report-only. A maintenance repair requires both `audit.repair.enabled=true` and a manual `workflow_dispatch` run with `repair_authorized=true` by a configured owner; scheduled runs always pass `false`.
- Configured-owner `/codekeeper triage` and `/codekeeper fix` comments require an `OWNER`, `MEMBER`, or `COLLABORATOR` association plus a GitHub login in `repository.ownerLogins`. The fix command must be the complete comment body. Manual fix dispatch also requires a configured owner.
- An issue fix may open a bounded repair pull request. A fix requested on an eligible same-repository pull request instead commits to that pull request's existing head branch; it never opens a second pull request and has no create-new-PR fallback. Fork pull requests, drafts, protected/default head branches, stale heads, and unsupported targets fail closed.

Treebar-specific paths and policy are kept only as an optional [example](examples/treebar/README.md); they are not runtime defaults.

## Local verification

```bash
node tools/codekeeper/src/cli.mjs check-config
cd tools/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
```

The package pins its Agents SDK dependencies and requires Node.js 22 or newer locally. The reusable workflows pin Node.js, npm dependencies, and the optional Codex CLI themselves.

## Source releases

Source releases are built only from a clean, immutable Git commit. The release command archives tracked content, verifies the unpacked manifest and inventory, and prints the archive checksum:

```bash
mkdir -p ../codekeeper-release-artifacts
bash scripts/release-source.sh --output ../codekeeper-release-artifacts
```

See [validation](VALIDATION.md#source-release-integrity) for the clean-tree requirement, verification-only command, and the boundary between source integrity and GitHub release visibility.
