# Install in a GitHub.com repository

## 1. Add policy and caller workflows

Copy [`.github/codekeeper.json`](.github/codekeeper.json) to the adopter repository's default branch. Copy only the caller templates needed from [`examples/workflows`](examples/workflows) to `.github/workflows/`, remove `.example`, and replace both placeholders in every caller:

```text
OWNER/REPOSITORY
FULL_COMMIT_SHA
```

`FULL_COMMIT_SHA` must be the full immutable commit SHA of a reviewed release of this repository. Replace it identically in both the direct bootstrap-action pin and reusable-workflow pin that each template contains. The bootstrap action accepts no caller-provided secrets and, using GitHub's private-action access, stages only the production Codekeeper runtime as a per-run one-day artifact. Every reusable job rejects that artifact unless it matches the source-pinned manifest, inventory, file hashes, and no-symlink/no-hidden-path rules before `npm` or the CLI runs. Hidden paths are refused to match GitHub artifact uploads' secure default. The caller owns triggers and credentials; it needs no PAT, App installation on the source repository, or caller-controlled source trust. Configure the private source repository's Actions access policy to allow the adopter repository to use the pinned action. The review caller uses `pull_request_target`, so GitHub evaluates its definition and secret mapping from the default branch; the caller only invokes the reusable workflow and never checks out or executes PR code. Do not copy this repository's `tools/` directory or reusable workflow files into the adopter.

## 2. Tailor the policy before enabling

Update these values in the adopter's `.github/codekeeper.json`:

- `repository.displayName`, `defaultBranch`, `ownerLogins`, and `automationBranchPrefix`.
- `projectInvariants` for repository-specific non-negotiables.
- Repair `allowedPaths`, `protectedPaths`, limits, and deterministic `validationCommands`.
- Auto-merge paths and eligible authors. The supplied policy permits only small Markdown changes to auto-merge.
- Per-mode `ai.agents.<mode>` provider/model/settings and any optional Codex workspace. `audit.repair.enabled`, `issues.allowAiImplementation`, and `merge.enabled` are all false by default. The pinned source revision also supplies the four executable coordinator profiles under `tools/codekeeper/agents/`; do not copy or alter them in the adopter repository.

| Coordinator | Versioned profile path |
|---|---|
| Pull request reviewer | `tools/codekeeper/agents/pr-reviewer.md` |
| Issue triager | `tools/codekeeper/agents/issue-triager.md` |
| Repository auditor | `tools/codekeeper/agents/repository-auditor.md` |
| Maintenance planner | `tools/codekeeper/agents/maintenance-planner.md` |

The workflow rejects a policy whose `defaultBranch` differs from GitHub's repository default branch. Keep the supplied `codekeeper:*` labels, plus explicit `review.managedLabels` and `issues.managedLabels`; runtime emission depends on those exact names.

Validate a tailored copy before committing it:

```bash
node tools/codekeeper/src/cli.mjs check-config --config .github/codekeeper.json
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
CODEKEEPER_APP_CLIENT_ID=<GitHub App client ID>              # Required by review/issue and maintenance/fix dry_run=false
CODEKEEPER_AUTOMATION_BOT_LOGIN=<app-slug>[bot]             # Actions variable, review caller only
CODEKEEPER_APP_PRIVATE_KEY=<full GitHub App PEM>            # Required by review/issue and maintenance/fix dry_run=false
OPENAI_API_KEY=<OpenAI coordinator/workspace key>              # Actions secret when a mode uses OpenAI
DEEPSEEK_API_KEY=<DeepSeek coordinator key>                    # Actions secret for the starter issue mode
OPENAI_TRACE_API_KEY=<dedicated OpenAI trace-export key>       # Actions secret; never a model/provider key
CODEKEEPER_ENABLED=false                                   # Actions variable initially
```

The App token is present only in publication jobs. Maintenance and fix callers may map empty App values for `dry_run=true`; their reusable contracts do not require an App client ID or private key until `dry_run=false` selects publication, where both are checked before token minting. Review and issue-triage always publish, so their App mappings remain required. Codex runs in a separate workspace-only job, while model and trace credentials are present only in the fresh coordinator job; the coordinator binds its rebuilt context to the workspace context digest and treats the transferred specialist result and any audit/fix patch as untrusted. The starter policy enables Agents SDK tracing with `includeSensitiveData=false`; every caller maps a separate `trace_api_key`. View runs at [OpenAI Platform Traces](https://platform.openai.com/traces) under **Logs > Traces**. This remains true for the DeepSeek issue mode: never map the DeepSeek provider key to `trace_api_key`.

## 4. Prove the configuration before making the gate required

Commit the configuration and callers to the default branch with `CODEKEEPER_ENABLED=false`. When ready to prove the configuration, set it to `true` and run the maintenance caller manually with `dry_run=true` first. It validates and seals an artifact but does not mutate labels, issues, branches, or pull requests, and does not require the maintenance App client ID or private-key mapping.

Then open a small same-repository pull request targeting the default branch. The supplied caller sets `auto_review: true`; keep it true while proving the required review gate. Confirm that the caller's **Codekeeper review gate** completes and the App identity, labels, and `PR review summary` comment are correct before adding the gate to branch protection.

Branch protection remains the source of truth. Keep normal build, test, approval, and deployment checks required independently of this workflow.

## 5. Choose automatic triage and use configured-owner commands

The supplied issue caller opts in to `auto_triage: true`, so opened, reopened, and edited issues receive bounded automatic triage. Automatic triage can label, comment, and identify a duplicate candidate; it does not close an issue because `issues.closeExactDuplicates` remains false by default. Set `auto_triage: false` in the caller to skip those automatic events.

Only a GitHub login listed in `repository.ownerLogins` can request manual issue triage or a fix. Comment-triggered requests must also have an `OWNER`, `MEMBER`, or `COLLABORATOR` association. Manual triage remains available even with `auto_triage: false`:

```text
/codekeeper triage
```

For a bounded issue implementation:

```text
/codekeeper fix
```

The maintenance caller can also run on a schedule or through `workflow_dispatch`; keep its first run dry.

## Limits to keep in branch rules

- GitHub Enterprise Server is unsupported.
- Fork pull requests, drafts, disabled runs, and non-default-branch PR targets fail the review gate closed and need manual review.
- The supplied review caller does not handle `merge_group`; do not require its gate for merge queues.
- Set `auto_review: false` only when the failing-closed review gate is intentionally not required. Set `auto_triage: false` to require configured-owner triage commands while retaining automatic issue labels, comments, and duplicate candidates only when it is true.

Treebar is an optional [policy example](examples/treebar/README.md), not an installation target or runtime dependency.
