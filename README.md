# AI Repo Maintainer

AI Repo Maintainer is a set of **versioned reusable GitHub Actions workflows** for one repository at a time. It uses four independently configured Agents SDK coordinators to review same-repository pull requests, triage maintainer-requested issues, audit the default branch, and implement explicitly enabled, bounded fixes.

It is not a hosted service, webhook receiver, multi-tenant GitHub App, or npm package. Each adopter owns its GitHub App credentials and policy; caller workflows pin this repository to an immutable release commit.

## What adopters install

| Reusable workflow | Caller responsibility |
|---|---|
| `ai-maintainer-review.yml` | Review eligible pull requests and expose a fail-closed review gate. |
| `ai-maintainer-maintain.yml` | Run scheduled or manually dispatched default-branch audits. |
| `ai-maintainer-issues.yml` | Triage an issue only after a configured owner comments `/ai-maintainer triage`. |
| `ai-maintainer-fix.yml` | Implement an issue only after a configured owner requests `/ai-maintainer fix` or manual dispatch. |

Copy the matching non-executable templates from [`examples/workflows`](examples/workflows) into the adopter repository, replace `OWNER/REPOSITORY` and `FULL_COMMIT_SHA`, and copy [`.github/ai-maintainer.json`](.github/ai-maintainer.json) into the adopter's default branch. The reusable workflows check out their own pinned tooling revision; adopters do not copy `tools/ai-maintainer` or the source workflow files.

The root policy is a valid starter, not a safe default for every repository. Before enabling it, replace `repository.ownerLogins`, verify the default branch and automation prefix, and tailor repair, validation, and auto-merge paths. Each mode has its own `ai.agents.<mode>` provider, model, settings, and optional Codex workspace specialist. The runtime label names are intentionally namespaced and must remain defined exactly as supplied. See [configuration](docs/CONFIGURATION.md).

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
- Issue triage and fixes are configured-owner-command-only, not automatic for new or edited public issues.
- A command caller must have an `OWNER`, `MEMBER`, or `COLLABORATOR` association and a GitHub login listed in `repository.ownerLogins`. Manual fix dispatch also requires a configured owner.

Treebar-specific paths and policy are kept only as an optional [example](examples/treebar/README.md); they are not runtime defaults.

## Local verification

```bash
node tools/ai-maintainer/src/cli.mjs check-config
cd tools/ai-maintainer && npm ci --ignore-scripts --no-audit --no-fund && npm run check
```

The package pins its Agents SDK dependencies and requires Node.js 22 or newer locally. The reusable workflows pin Node.js, npm dependencies, and the optional Codex CLI themselves.
