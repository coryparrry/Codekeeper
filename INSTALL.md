# Install in a GitHub.com repository

## Guided installer status

The separate [`codekeeper` installer](packages/codekeeper/README.md) is the preferred guided path. It opens a keyboard-driven terminal UI on Node.js 22+, but remains private and unpublished during acceptance. Do not assume `npx codekeeper init` resolves to this project from the public npm registry yet. Build a local tarball from this checkout and invoke that exact file instead:

```bash
mkdir -p /absolute/path/outside/source-checkout/codekeeper-dist
cd packages/codekeeper
npm pack --pack-destination /absolute/path/outside/source-checkout/codekeeper-dist
cd /absolute/path/to/adopter-repository
npm exec --package /absolute/path/outside/source-checkout/codekeeper-dist/codekeeper-0.2.0.tgz -- codekeeper init
```

The tarball includes the reviewed npm shrinkwrap, so this invocation installs the exact
dependency versions and integrity hashes reviewed in this checkout rather than resolving
new versions that merely satisfy transitive semver ranges.

The installer generates a disabled setup PR from assets pinned to the proven source checkpoint; it does not deliver the private runtime through npm. Review the generated policy, callers, and agent profiles before merging. If the installer cannot be used, the numbered steps below remain the manual fallback.

The installer metadata in an older checkout may still pin a source checkpoint that predates adopter-owned profiles, owner-authorized maintenance repair, and same-PR repair. That older pin does **not** provide the behavior described below. Do not test or deploy these contracts until installer metadata names the final reviewed source checkpoint containing them; building a newer tarball does not change an older embedded pin.

If you are unsure which options to choose, accept the recommended starter setup: pull-request review plus repository maintenance, the `openai` preset, the repository name as the comment display name, and your authenticated GitHub login as the owner-command user. Issue triage and the separately gated fix path can be added later through a reviewed policy/workflow change.

Before the installer's final confirmation, choose the newly downloaded GitHub App `.pem` file in its metadata-only picker. Do not open or paste the PEM contents. The picker ignores symlinks and does not read the file; after confirmation, the installer opens it read-only and passes its descriptor directly to GitHub CLI. It does not expose the path or key through terminal output, argv, environment variables, logs, generated files, or snapshots.

After the setup PR merges, review events intentionally fail the `Codekeeper review gate` while `CODEKEEPER_ENABLED=false`; do not make that gate required until the controlled review proof passes. The maintenance caller also retains its schedule, although only its pinned bootstrap can run while disabled.

## 1. Add policy, profiles, and caller workflows

Copy [`.github/codekeeper.json`](.github/codekeeper.json) to the adopter repository's default branch. Create `.github/codekeeper/agents/` and copy all four bundled seed profiles into these exact paths:

```text
.github/codekeeper/agents/pr-reviewer.md
.github/codekeeper/agents/issue-triager.md
.github/codekeeper/agents/repository-auditor.md
.github/codekeeper/agents/maintenance-planner.md
```

The seed content is under [`tools/codekeeper/agents`](tools/codekeeper/agents). The guided installer always creates all four profiles, even when only some workflows are selected, so later mode additions start from the same reviewed checkpoint.

Copy only the caller templates needed from [`examples/workflows`](examples/workflows) to `.github/workflows/`, remove `.example`, and replace both placeholders in every caller:

```text
OWNER/REPOSITORY
FULL_COMMIT_SHA
```

`FULL_COMMIT_SHA` must be the full immutable commit SHA of a reviewed release of this repository. Replace it identically in both the direct bootstrap-action pin and reusable-workflow pin that each template contains. The bootstrap action accepts no caller-provided secrets and, using GitHub's private-action access, stages only the production Codekeeper runtime as a per-run one-day artifact. Every reusable job rejects that artifact unless it matches the source-pinned manifest, inventory, file hashes, and no-symlink/no-hidden-path rules before `npm` or the CLI runs. Hidden paths are refused to match GitHub artifact uploads' secure default. The caller owns triggers and credentials; it needs no PAT, App installation on the source repository, or caller-controlled source trust. Configure the private source repository's Actions access policy to allow the adopter repository to use the pinned action. The review caller uses `pull_request_target`, so GitHub evaluates its definition and secret mapping from the default branch; the caller only invokes the reusable workflow and never checks out or executes PR code. Do not copy this repository's `tools/` directory or reusable workflow files beyond the four Markdown seeds listed above.

## 2. Tailor the policy before enabling

Update these values in the adopter's `.github/codekeeper.json`:

- `repository.displayName`, `defaultBranch`, `ownerLogins`, and `automationBranchPrefix`.
- `projectInvariants` for repository-specific non-negotiables.
- Repair `allowedPaths`, `protectedPaths`, limits, and deterministic `validationCommands`.
- Auto-merge paths and eligible authors. The supplied policy permits only small Markdown changes to auto-merge.
- Per-mode `ai.agents.<mode>` provider/model/settings and any optional Codex workspace. `audit.repair.enabled`, `issues.allowAiImplementation`, and `merge.enabled` are all false by default.
- The four Markdown profiles under `.github/codekeeper/agents/`. Use them to tune evidence thresholds, prioritization, test expectations, duplicate decisions, no-action behavior, and report wording.

| Coordinator | Adopter-owned profile path |
|---|---|
| Pull request reviewer | `.github/codekeeper/agents/pr-reviewer.md` |
| Issue triager | `.github/codekeeper/agents/issue-triager.md` |
| Repository auditor | `.github/codekeeper/agents/repository-auditor.md` |
| Maintenance planner | `.github/codekeeper/agents/maintenance-planner.md` |

Profiles change judgment, not authorization. They cannot enable Codekeeper, permit maintenance or issue repair, weaken allowed/protected paths, bypass validation, authorize merge, change the run target, or grant credentials, tools, or network access. The workflow reads the selected profile from the trusted default branch, freezes its source commit and digest with the run, and refuses publication if that trusted file drifts before publication. A profile change on an unmerged pull-request branch cannot affect that pull request's run.

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

For the manual fallback, submit the App PEM from its file instead of pasting it into an interactive prompt:

```bash
gh secret set CODEKEEPER_APP_PRIVATE_KEY --app actions --repo OWNER/REPOSITORY < /absolute/path/to/downloaded-private-key.pem
```

The App token is present only in publication jobs. Maintenance and fix callers may map empty App values for `dry_run=true`; their reusable contracts do not require an App client ID or private key until `dry_run=false` selects publication, where both are checked before token minting. Review and issue-triage always publish, so their App mappings remain required. Codex runs in a separate workspace-only job, while model and trace credentials are present only in the fresh coordinator job; the coordinator binds its rebuilt context to the workspace context digest and treats the transferred specialist result and any audit/fix patch as untrusted. The starter policy enables Agents SDK tracing with `includeSensitiveData=false`; every caller maps a separate `trace_api_key`. View runs at [OpenAI Platform Traces](https://platform.openai.com/traces) under **Logs > Traces**. This remains true for the DeepSeek issue mode: never map the DeepSeek provider key to `trace_api_key`.

## 4. Prove the configuration before making the gate required

Commit the configuration, profiles, and callers to the default branch with `CODEKEEPER_ENABLED=false`. When ready to prove the configuration, set it to `true` and run the maintenance caller manually with `dry_run=true` and `repair_authorized=false` first. It validates and seals an artifact but does not mutate labels, issues, branches, or pull requests, and does not require the maintenance App client ID or private-key mapping.

Then open a small same-repository pull request targeting the default branch. The supplied caller sets `auto_review: true`; keep it true while proving the required review gate. Confirm that the caller's **Codekeeper review gate** completes and the App identity, labels, and `PR review summary` comment are correct before adding the gate to branch protection.

Branch protection remains the source of truth. Keep normal build, test, approval, and deployment checks required independently of this workflow.

## 5. Choose automatic triage and use configured-owner commands

The supplied issue caller opts in to `auto_triage: true`, so opened, reopened, and edited issues receive bounded automatic triage. Automatic triage can label, comment, and identify a duplicate candidate; it does not close an issue because `issues.closeExactDuplicates` remains false by default. Set `auto_triage: false` in the caller to skip those automatic events.

Only a GitHub login listed in `repository.ownerLogins` can request manual issue triage or a fix. Comment-triggered requests must also have an `OWNER`, `MEMBER`, or `COLLABORATOR` association. Manual triage remains available even with `auto_triage: false`:

```text
/codekeeper triage
```

For a bounded issue implementation, add a comment whose complete body is exactly:

```text
/codekeeper fix
```

Do not add arguments or other text to that comment. For an issue, an accepted fix may open one bounded repair pull request. The workflow never repairs an issue merely because it was opened, edited, or triaged.

The same exact owner command can be added to an eligible open, non-draft, same-repository pull request targeting the default branch. Codekeeper freezes that pull request's current head and, after validation, pushes one App-owned commit to its existing head branch. It does not open a second pull request and does not fall back to creating one. Forks, default/protected head branches, stale heads, and changed targets fail closed.

Maintenance schedules are always report-only. A manually dispatched maintenance run is also report-only unless all of the following are true:

- The actor is listed in `repository.ownerLogins`.
- `audit.repair.enabled=true` in the trusted policy.
- That individual `workflow_dispatch` sets `repair_authorized=true`.
- `dry_run=false`, and the resulting patch passes every configured path, size, and validation gate.

The authorization applies only to that run; schedules always pass `repair_authorized=false`. Keep the first run dry and unauthorized.

## Limits to keep in branch rules

- GitHub Enterprise Server is unsupported.
- Fork pull requests, drafts, disabled runs, and non-default-branch PR targets fail the review gate closed and need manual review.
- The supplied review caller does not handle `merge_group`; do not require its gate for merge queues.
- Set `auto_review: false` only when the failing-closed review gate is intentionally not required. Set `auto_triage: false` to require configured-owner triage commands while retaining automatic issue labels, comments, and duplicate candidates only when it is true.

Treebar is an optional [policy example](examples/treebar/README.md), not an installation target or runtime dependency.
