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

The installer opens one tabbed Settings screen and generates a setup or configuration PR from assets pinned to the proven source checkpoint; it does not deliver the private runtime through npm. Simple mode puts provider, model, and effort choices first. Advanced mode uses the same sections and exposes every editable policy field while keeping deterministic safety and release boundaries read-only. Review the short summary or return to Settings at the final mutation boundary. If the installer cannot be used, the numbered steps below remain the manual fallback.

If you are unsure which options to choose, accept the recommended starter setup: pull-request review plus repository maintenance, the `openai` preset, the repository name as the comment display name, and your authenticated GitHub login as the owner-command user. Issue triage and the separately gated fix path can be added later through a reviewed policy/workflow change.

Before the installer's final confirmation, choose the newly downloaded GitHub App `.pem` file in its metadata-only picker. Do not open or paste the PEM contents. The picker ignores symlinks and does not read the file; after confirmation, the installer opens it read-only and passes its descriptor directly to GitHub CLI. It does not expose the path or key through terminal output, argv, environment variables, logs, generated files, or snapshots.

After the setup PR merges, review events intentionally fail the `Codekeeper review gate` while `CODEKEEPER_ENABLED=false`; do not make that gate required until the controlled review proof passes. The maintenance caller retains its schedule, but its runtime jobs skip package acquisition and analysis while disabled.

## 1. Add policy and caller workflows

Copy [`.github/codekeeper.json`](.github/codekeeper.json) to the adopter repository's default branch. The pinned runtime supplies the default profile for every coordinator, so a new installation does not create `.github/codekeeper/agents/`. To opt into repository-specific judgment, copy only the profiles you intend to override into their exact paths:

```text
.github/codekeeper/agents/pr-reviewer.md
.github/codekeeper/agents/issue-triager.md
.github/codekeeper/agents/repository-auditor.md
.github/codekeeper/agents/fixer.md
```

The default content is under [`tools/codekeeper/agents`](tools/codekeeper/agents). The guided installer creates an override only after that profile is edited in Settings. Missing paths remain valid and track future packaged defaults.

Always copy `codekeeper-assistant.yml.example`, then copy the role caller templates needed from [`examples/workflows`](examples/workflows) to `.github/workflows/` and remove `.example`. Copy the matching reusable workflows from this repository's `.github/workflows/codekeeper-<role>.yml` files to `.github/workflows/codekeeper-runtime-<role>.yml` in the adopter repository. Also copy [the exact-package acquisition action](.github/codekeeper/actions/acquire-package/action.yml) to the same path in the adopter repository. Replace both package placeholders in every caller:

```text
PACKAGE_VERSION
PACKAGE_INTEGRITY
```

`PACKAGE_VERSION` must be one exact published Codekeeper version. `PACKAGE_INTEGRITY` must be that same npm release's exact `dist.integrity` SHA-512 value. The first runtime job uses the local action to download those exact package bytes, reject a registry receipt or tarball mismatch, and verify the package's source identity and closed file manifest. It shares the verified package as a one-day, run-scoped artifact. Every later isolated job downloads and independently reverifies that artifact before installing the runtime without lifecycle scripts. The caller owns triggers and credentials; it needs no PAT, App installation on the source repository, or caller-controlled source trust. The review caller uses `pull_request_target`, so GitHub evaluates its definition and secret mapping from the default branch; the caller only invokes local reusable workflows and never checks out or executes PR code. Do not copy this repository's `tools/` directory or agent-profile files unless you are intentionally creating one of the four documented overrides.

## 2. Tailor the policy before enabling

Update these values in the adopter's `.github/codekeeper.json`:

- `repository.displayName`, `defaultBranch`, `ownerLogins`, and `automationBranchPrefix`.
- `projectInvariants` for repository-specific non-negotiables.
- Repair `allowedPaths`, `protectedPaths`, limits, and deterministic `validationCommands`.
- Auto-merge paths and eligible authors. The supplied policy permits only small Markdown changes to auto-merge.
- Per-mode `ai.agents.<mode>` provider/model/settings and any optional Codex workspace. `audit.repair.enabled`, `issues.allowAiImplementation`, and `merge.enabled` are all false by default.
- `automation` controls for automatic PR review, review-feedback triage, issue triage, owner requests, and the maintenance schedule. `review.createDeferredIssues` is independently configurable.
- Optional Markdown overrides under `.github/codekeeper/agents/`. Use them only to diverge from packaged evidence thresholds, prioritization, test expectations, duplicate decisions, no-action behavior, or report wording.

| Coordinator | Optional adopter override path |
|---|---|
| Pull request reviewer | `.github/codekeeper/agents/pr-reviewer.md` |
| Issue triager | `.github/codekeeper/agents/issue-triager.md` |
| Repository auditor | `.github/codekeeper/agents/repository-auditor.md` |
| Fixer | `.github/codekeeper/agents/fixer.md` |

Profiles change judgment, not authorization. They cannot enable Codekeeper, permit maintenance or issue repair, weaken allowed/protected paths, bypass validation, authorize merge, change the run target, or grant credentials, tools, or network access. The workflow loads the selected profile from the verified package or the trusted default-branch override, freezes its source provenance and digest with the run, and refuses publication if that selected source drifts before publication. A profile change on an unmerged pull-request branch cannot affect that pull request's run.

The workflow rejects a policy whose `defaultBranch` differs from GitHub's repository default branch. Keep the supplied labels, plus explicit `review.managedLabels` and `issues.managedLabels`; runtime emission depends on those exact names.

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
OPENROUTER_API_KEY=<OpenRouter coordinator key>                # Actions secret when a mode uses OpenRouter
OPENAI_TRACE_API_KEY=<dedicated OpenAI trace-export key>       # Actions secret; never a model/provider key
CODEKEEPER_ENABLED=false                                   # Actions variable initially
```

For the manual fallback, submit the App PEM from its file instead of pasting it into an interactive prompt:

```bash
gh secret set CODEKEEPER_APP_PRIVATE_KEY --app actions --repo OWNER/REPOSITORY < /absolute/path/to/downloaded-private-key.pem
```

The App token is present only in publication jobs. Maintenance and fix callers may map empty App values for `dry_run=true`; their reusable contracts do not require an App client ID or private key until `dry_run=false` selects publication, where both are checked before token minting. Review and issue-triage always publish, so their App mappings remain required. Codex runs in a separate workspace-only job, while model and trace credentials are present only in the fresh coordinator job; the coordinator binds its rebuilt context to the workspace context digest and treats the transferred specialist result and any audit/fix patch as untrusted. The starter policy enables Agents SDK tracing with `includeSensitiveData=false` and exports traces through OpenAI. Never reuse a model-provider key as an observability key.

When updating an installation that used the retired alternate trace exporter, configure `OPENAI_TRACE_API_KEY` or disable tracing before merging the update. After merge, remove the now-ignored alternate-exporter variables and secrets.

## 4. Prove the configuration before making the gate required

Commit the configuration, callers, and any intentional profile overrides to the default branch. Run the maintenance caller manually with `dry_run=true` first. It validates and seals an artifact but does not mutate labels, issues, branches, or pull requests, and does not require the maintenance App client ID or private-key mapping.

Then open a small same-repository pull request targeting the default branch. The supplied caller sets `auto_review: true`; keep it true while proving the required review gate. Confirm that the caller's **Codekeeper review gate** completes and the App identity, labels, and `PR review summary` comment are correct before adding the gate to branch protection.

Branch protection remains the source of truth. Keep normal build, test, approval, and deployment checks required independently of this workflow.

## 5. Choose automatic triage and issue implementation

The supplied issue caller opts in to `auto_triage: true`, so opened, reopened, and edited issues receive bounded automatic triage. Automatic triage can label, comment, and identify a duplicate candidate; it does not close an issue because `issues.closeExactDuplicates` remains false by default. Set `auto_triage: false` in the caller to skip those automatic events.

Only a GitHub login listed in `repository.ownerLogins` can request manual issue triage or a fix. Comment-triggered requests must also have an `OWNER`, `MEMBER`, or `COLLABORATOR` association. Manual triage remains available even with `auto_triage: false`:

```text
/codekeeper triage
```

On a pull request review thread, `/codekeeper defer` is an unconditional owner-authorized deferral. It must reply to the review comment that should become an issue; it does not ask the reviewer or model to verify the claim first. The assistant creates or updates one fingerprinted deferred issue, replies with its link, and lets normal issue triage apply priority, risk, readiness, testing, duplicate, and manual-review labels.

When `issues.allowAiImplementation=true`, trusted triage adds `ready` only to a clear, bounded, testable issue. That label starts the issue implementation workflow, which may open one bounded repair pull request.

The same exact owner command can be added to an eligible open, non-draft, same-repository pull request targeting the default branch. Codekeeper freezes that pull request's current head and, after validation, pushes one App-owned commit to its existing head branch. It does not open a second pull request and does not fall back to creating one. Forks, default/protected head branches, stale heads, and changed targets fail closed.

A maintenance run is report-only when `dry_run=true` or `audit.repair.enabled=false`. When repository repair is on, a live manual or scheduled run may make one repair that passes the configured path, size, and validation limits.

## Limits to keep in branch rules

- GitHub Enterprise Server is unsupported.
- Fork pull requests, drafts, disabled runs, and non-default-branch PR targets fail the review gate closed and need manual review.
- The supplied review caller does not handle `merge_group`; do not require its gate for merge queues.
- Set `auto_review: false` only when the failing-closed review gate is intentionally not required. Set `auto_triage: false` to require configured-owner triage commands while retaining automatic issue labels, comments, and duplicate candidates only when it is true.

Treebar is an optional [policy example](examples/treebar/README.md), not an installation target or runtime dependency.
