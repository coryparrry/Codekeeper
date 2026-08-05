# Install in a GitHub.com repository

## 1. Add policy and caller workflows

Copy [`.github/ai-maintainer.json`](.github/ai-maintainer.json) to the adopter repository's default branch. Copy only the caller templates needed from [`examples/workflows`](examples/workflows) to `.github/workflows/`, remove `.example`, and replace both placeholders in every caller:

```text
OWNER/REPOSITORY
FULL_COMMIT_SHA
```

`FULL_COMMIT_SHA` must be the full immutable commit SHA of a reviewed release of this repository. The caller owns triggers and credentials; the reusable workflow checks out the pinned source revision itself. The review caller uses `pull_request_target`, so GitHub evaluates its definition and secret mapping from the default branch; the caller only invokes the reusable workflow and never checks out or executes PR code. Do not copy this repository's `tools/` directory or reusable workflow files into the adopter.

## 2. Tailor the policy before enabling

Update these values in the adopter's `.github/ai-maintainer.json`:

- `repository.displayName`, `defaultBranch`, `ownerLogins`, and `automationBranchPrefix`.
- `projectInvariants` for repository-specific non-negotiables.
- Repair `allowedPaths`, `protectedPaths`, limits, and deterministic `validationCommands`.
- Auto-merge paths and eligible authors. The supplied policy permits only small Markdown changes to auto-merge.
- Per-mode `ai.agents.<mode>` provider/model/settings and any optional Codex workspace. `audit.repair.enabled`, `issues.allowAiImplementation`, and `merge.enabled` are all false by default.

The workflow rejects a policy whose `defaultBranch` differs from GitHub's repository default branch. Keep the supplied `ai-maintainer:*` labels, plus explicit `review.managedLabels` and `issues.managedLabels`; runtime emission depends on those exact names.

Validate a tailored copy before committing it:

```bash
node tools/ai-maintainer/src/cli.mjs check-config --config .github/ai-maintainer.json
```

That command is available from a local checkout of this source repository. The reusable workflows run the same validation before analysis.

## 3. Create an adopter-owned GitHub App

Create a GitHub App and install it only where automation is intended. No webhook URL is needed.

| Repository permission | Access |
|---|---|
| Contents | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Metadata | Read-only |

Set these adopter repository values and secrets:

```text
AI_MAINTAINER_APP_CLIENT_ID=<GitHub App client ID>              # Actions variable
AI_MAINTAINER_AUTOMATION_BOT_LOGIN=<app-slug>[bot]             # Actions variable, review caller only
AI_MAINTAINER_APP_PRIVATE_KEY=<full GitHub App PEM>            # Actions secret
OPENAI_API_KEY=<OpenAI coordinator/workspace key>              # Actions secret when a mode uses OpenAI
DEEPSEEK_API_KEY=<DeepSeek coordinator key>                    # Actions secret for the starter issue mode
OPENAI_TRACE_API_KEY=<dedicated OpenAI trace-export key>       # Actions secret; never a model/provider key
AI_MAINTAINER_ENABLED=false                                   # Actions variable initially
```

The App token is present only in publication jobs. Codex runs in a separate workspace-only job, while model and trace credentials are present only in the fresh coordinator job; the coordinator binds its rebuilt context to the workspace context digest and treats the transferred specialist result and any audit/fix patch as untrusted. The starter policy enables Agents SDK tracing with `includeSensitiveData=false`; every caller maps a separate `trace_api_key`. View runs at [OpenAI Platform Traces](https://platform.openai.com/traces) under **Logs > Traces**. This remains true for the DeepSeek issue mode: never map the DeepSeek provider key to `trace_api_key`.

## 4. Prove the configuration before making the gate required

Commit the configuration and callers to the default branch with `AI_MAINTAINER_ENABLED=false`. Run the maintenance caller manually with `dry_run=true` first. It validates and seals an artifact but does not mutate labels, issues, branches, or pull requests.

Then enable the variable and open a small same-repository pull request targeting the default branch. Confirm that the caller's **AI Maintainer review gate** completes and the App identity, labels, and comment are correct before adding the gate to branch protection.

Branch protection remains the source of truth. Keep normal build, test, approval, and deployment checks required independently of this workflow.

## 5. Use configured-owner commands

Only a GitHub login listed in `repository.ownerLogins` can request issue triage or a fix. Comment-triggered requests must also have an `OWNER`, `MEMBER`, or `COLLABORATOR` association. Use:

```text
/ai-maintainer triage
```

For a bounded issue implementation:

```text
/ai-maintainer fix
```

The maintenance caller can also run on a schedule or through `workflow_dispatch`; keep its first run dry.

## Limits to keep in branch rules

- GitHub Enterprise Server is unsupported.
- Fork pull requests, drafts, disabled runs, and non-default-branch PR targets fail the review gate closed and need manual review.
- The supplied review caller does not handle `merge_group`; do not require its gate for merge queues.
- New and edited public issues are not automatically triaged. Only configured-owner commands run issue triage or fixes.

Treebar is an optional [policy example](examples/treebar/README.md), not an installation target or runtime dependency.
