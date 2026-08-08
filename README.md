# Codekeeper

Codekeeper is a set of **versioned reusable GitHub Actions workflows** for one repository at a time. It uses four independently configured Agents SDK coordinators to review same-repository pull requests, triage bounded issue lifecycle events or maintainer commands, audit the default branch, and implement explicitly enabled, bounded fixes.

It is not a hosted service, webhook receiver, multi-tenant GitHub App, or npm package. Each adopter owns its GitHub App credentials and policy; caller workflows pin this repository to an immutable release commit.

## What adopters install

| Reusable workflow | Caller responsibility |
|---|---|
| `codekeeper-review.yml` | Review eligible pull requests and expose a fail-closed review gate. |
| `codekeeper-maintain.yml` | Run scheduled or manually dispatched default-branch audits. |
| `codekeeper-issues.yml` | Triage opened, reopened, or edited issues while `auto_triage=true`; configured-owner `/codekeeper triage` comments remain available when automatic triage is off. |
| `codekeeper-fix.yml` | Implement an issue only after a configured owner requests `/codekeeper fix` or manual dispatch. |

Copy the matching non-executable templates from [`examples/workflows`](examples/workflows) into the adopter repository, replace `OWNER/REPOSITORY` and `FULL_COMMIT_SHA`, and copy [`.github/codekeeper.json`](.github/codekeeper.json) into the adopter's default branch. The reusable workflows check out their own pinned tooling revision; adopters do not copy `tools/codekeeper` or the source workflow files.

The root policy is a valid starter, not a safe default for every repository. Before enabling it, replace `repository.ownerLogins`, verify the default branch and automation prefix, and tailor repair, validation, and auto-merge paths. Each mode has its own `ai.agents.<mode>` provider, model, settings, and optional Codex workspace specialist. The runtime label names are intentionally namespaced and must remain defined exactly as supplied. See [configuration](docs/CONFIGURATION.md).

## Coordinator profiles

The four versioned Markdown profiles below are executable coordinator instructions: the runtime loads the selected file into the Agents SDK `Agent.instructions` and appends its shared security instructions. They make existing output capabilities explicit; they do not add independent tools, external skill packages, or access beyond the trusted runtime.

| Coordinator | Profile | Explicit responsibilities |
|---|---|---|
| Pull request reviewer | [`tools/codekeeper/agents/pr-reviewer.md`](tools/codekeeper/agents/pr-reviewer.md) | PR review summary, evidence-backed findings, risk, tests, and merge recommendation. |
| Issue triager | [`tools/codekeeper/agents/issue-triager.md`](tools/codekeeper/agents/issue-triager.md) | Issue classification, actionability, missing information, and duplicate assessment. |
| Repository auditor | [`tools/codekeeper/agents/repository-auditor.md`](tools/codekeeper/agents/repository-auditor.md) | Audit category and priority classification with bounded remediation guidance. |
| Maintenance planner | [`tools/codekeeper/agents/maintenance-planner.md`](tools/codekeeper/agents/maintenance-planner.md) | Bounded maintenance planning and no-change decisions within trusted repair limits. |

## Security model

- Codex runs in a workspace-only job with no model, trace, or GitHub App credential. A fresh coordinator job receives model and optional trace credentials, rebuilds trusted context, and treats the specialist artifact as untrusted evidence.
- The GitHub App write token exists only in publication; verification and sealing remain credential-free.
- Workflow code is fetched from the caller's pinned source revision; adopter policy is read only from its default branch.
- The review caller is a default-branch `pull_request_target` definition: it only invokes the reusable workflow and never checks out or executes PR code.
- Event fields, issue text, comments, repository files, and model output are treated as untrusted data. Frozen workflow context is embedded in the model prompt.
- Candidate output is structurally validated, copied into a sealed artifact, and published only by a later App-token job. Repository code is never executed in that publishing job.
- Repair patches are checked again in a fresh credential-free checkout before sealing and publication.
- Review labels, sticky comments, issue fingerprints, and repair PRs trust only the configured GitHub App bot identity.
- Auto-merge remains opt-in and is independently limited by author, branch, risk, tests, paths, files, changed lines, and complete frozen diff context.
- Agents SDK tracing is enabled by the starter policy with `includeSensitiveData=false`. It requires a separate OpenAI `trace_api_key` even when the selected model provider is DeepSeek; traces appear in [OpenAI Platform Traces](https://platform.openai.com/traces) under **Logs > Traces**.

See [the architecture](docs/ARCHITECTURE.md) and [installation guide](INSTALL.md) for the exact boundaries.

## Supported surface and limits

This release is **GitHub.com only**. It relies on reusable-workflow identity fields that are unavailable on GitHub Enterprise Server.

- Review supports non-draft, same-repository pull requests targeting the repository default branch. Forks, drafts, disabled runs, and non-default-branch targets fail the review gate closed.
- The supplied review caller does not subscribe to `merge_group`; do not make its gate required for merge queues.
- The review caller controls automatic PR review with `auto_review` (default `true`); setting it to `false` skips review and causes the required review gate to fail closed.
- The issue caller controls automatic issue triage with `auto_triage` (default `true`). Automatic triage is limited to opened, reopened, and edited issue events. It may publish labels, a sticky comment, and a duplicate candidate only; `issues.closeExactDuplicates` remains a separate default-`false` policy.
- Configured-owner `/codekeeper triage` and `/codekeeper fix` comments require an `OWNER`, `MEMBER`, or `COLLABORATOR` association plus a GitHub login in `repository.ownerLogins`. Manual fix dispatch also requires a configured owner.

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
