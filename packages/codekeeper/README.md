# Codekeeper installer

`codekeeper` is the Node.js installer for Codekeeper's versioned GitHub Actions workflows. `npx codekeeper init` opens a keyboard-driven terminal UI, generates a disabled setup on a new branch, pushes that branch, and opens a setup pull request. It does not install the private runtime into the adopter repository.

The package is currently **unpublished** while private acceptance is in progress. Exercise the exact local tarball from a clean adopter checkout:

```bash
npm exec --package /absolute/path/to/codekeeper-0.2.0.tgz -- codekeeper init
```

The v1 CLI surface is:

```bash
npx codekeeper init
npx codekeeper --help
npx codekeeper --version
```

Node.js 22 or newer, Git, and an authenticated current GitHub CLI are required. GitHub.com is the only supported host. In a real TTY, use the arrow keys, Space, Enter, and Escape to move through the installer. Plain prompts remain the fallback for limited terminals; `--help` and `--version` never start the terminal UI.

## Document map

| Document | Purpose | When to use |
|---|---|---|
| This `README.md` | Installer boundary, prerequisites, generated setup, and proof sequence. | Before and during `codekeeper init`. |
| [Source installation guide](https://github.com/coryparrry/Codekeeper/blob/5d87b00917a750344b4fc5dc78a1f6437439001c/INSTALL.md) | Full manual installation and credential boundaries at the pinned runtime checkpoint. | When auditing the generated setup or using the manual fallback. |
| Generated `.github/codekeeper.json` | Repository policy, model choices, protected paths, and disabled safety controls. | Before merging the setup PR and whenever policy changes. |
| Generated `.github/codekeeper/agents/*.md` | Adopter-editable evidence, risk, duplicate, test-adequacy, and no-action judgment for all four agents. | When tuning how Codekeeper reasons about repository evidence. |
| Generated `.github/workflows/codekeeper-*.yml` | Selected callers pinned to the exact tested Codekeeper source commit. | When reviewing triggers, permissions, or secret mappings. |
| [Canonical starter profiles](https://github.com/coryparrry/Codekeeper/tree/5d87b00917a750344b4fc5dc78a1f6437439001c/tools/codekeeper/agents) | Immutable source and provenance for the four starter Markdown files copied by this installer. | When comparing local profile changes with the release baseline. |

## What `init` does

The guided flow first offers a recommended starter setup: pull-request review, repository maintenance beginning with a manual dry run, and the `openai` preset. Select it to accept those choices. Model and publication jobs remain disabled, and issue-event automation plus the advanced fix path are omitted. The maintenance caller does include a scheduled trigger after merge; while `CODEKEEPER_ENABLED=false`, only its pinned bootstrap can run. PR events also run bootstrap and intentionally show a failed Codekeeper review gate while disabled, so do not make that gate required until the controlled review proof passes. Choose custom setup if you want review only, intend to prove additional workflows, or want DeepSeek for issue triage.

| Choice | What it adds |
|---|---|
| Pull request review | App-owned review output for controlled same-repository pull requests after Codekeeper is deliberately enabled. |
| Repository maintenance | Manual or scheduled audits; the first proof is a manual `dry_run=true` run with no GitHub mutation. |
| Issue triage | Issue-event labels and comments when enabled; not needed for the starter proof. |
| Owner-authorized issue fix | An advanced repair-PR path that still requires a separate policy opt-in and owner command. |

The `openai` preset uses one OpenAI Platform provider key for every selected workflow. The `mixed` preset uses DeepSeek only for issue triage and OpenAI for the others, so selecting issue triage can require both provider keys. Both presets also request a separate OpenAI Platform trace-export key and the downloaded GitHub App PEM private key. A ChatGPT subscription is not an API key. Changing a model later is a small `.github/codekeeper.json` edit, not an installer change; the final preview shows each exact provider, model, and effort before mutation.

After choosing the starter or custom path, the flow explains that the display name appears only in Codekeeper's GitHub comments and that owner logins control owner-only commands. It then confirms conservative policy invariants and:

1. Generates `.github/codekeeper.json`, all four editable profiles under `.github/codekeeper/agents/`, and only the selected caller workflows.
2. Keeps every reusable-workflow and bootstrap reference pinned to source commit `5d87b00917a750344b4fc5dc78a1f6437439001c`.
3. Prints and best-effort opens the prefilled GitHub App registration page. The adopter creates and installs the App; Codekeeper hosts no callback.
4. Before the final confirmation, opens a metadata-only file picker at Downloads (or the home folder fallback) that shows only real directories and nonempty regular `.pem` files within GitHub's 48 KB secret limit. It ignores symlinks, never reads PEM contents, and never prints the selected path.
5. Forces `CODEKEEPER_ENABLED=false`, invokes inherited-terminal `gh secret set` for each single-line provider or trace key, and feeds only the App PEM descriptor to `gh` through non-terminal standard input. An existing same-named secret is deliberately replaced only after its new input is supplied.
6. Creates `codekeeper/setup`, stages only generated paths, commits `chore(codekeeper): add disabled setup`, pushes the branch, and opens a setup PR.

It never merges the PR, enables automation, publishes an npm package, copies the runtime, or creates a hosted service.

## Editable agent behavior

Every installation includes these fixed, versioned starter files:

- `.github/codekeeper/agents/pr-reviewer.md`
- `.github/codekeeper/agents/repository-auditor.md`
- `.github/codekeeper/agents/issue-triager.md`
- `.github/codekeeper/agents/maintenance-planner.md`

Edit and review these Markdown files through an ordinary pull request. After merge, their trusted default-branch versions tune future decisions: evidence and confidence thresholds, introduced-versus-pre-existing findings, severity and priority, test adequacy, duplicate criteria, risk calibration, and when the right result is no action or manual review.

Profiles are guidance inside an immutable security envelope. They cannot enable a workflow, change an event trigger, grant workspace writes, expand allowed paths, remove protected paths, authorize a repair, choose a branch, create or merge a pull request, close an issue, expose a secret, or change GitHub App permissions. Those powers remain in the pinned runtime, caller workflows, `.github/codekeeper.json`, and GitHub repository settings.

In particular, issue triage does not authorize implementation. Issue repair requires an explicit configured-owner command and its separate policy gate. Maintenance remains report-only unless an owner explicitly commands a repair after the runtime supporting that command is installed. A repair requested on an existing same-repository pull request belongs on that pull request's current head branch; it must not open a second pull request. These mutation guarantees are runtime rules, not promises that profile prose can grant or waive.

## Preflight and safe failure

`init` refuses to mutate the checkout when any prerequisite is unsafe or ambiguous. Rejections include:

- a missing or unauthenticated `gh`, GitHub Enterprise Server, or missing repository admin access;
- a dirty checkout, detached `HEAD`, stale local checkout, or a `HEAD` that is not the remote default branch;
- an existing Codekeeper policy or caller, an existing `codekeeper/setup` branch, or a generated-file collision.

The same collision checks cover all four agent profiles and every parent directory. Case-colliding paths, symlinked parents, and symlinked profile targets fail before any generated file is written.

If App registration, a secret prompt, push, or PR creation fails after setup begins, `CODEKEEPER_ENABLED` remains false and recoverable branch or PR state is preserved. Follow the exact command sequence printed by the installed binary; it never resolves an unpublished package from the npm registry. On Windows, printed recovery commands use PowerShell syntax. Do not merge or enable a partial setup.

## GitHub App and secret boundary

The GitHub App needs contents, issues, and pull requests read-write plus metadata read-only, with webhooks disabled. Its settings page shows both a numeric **App ID** and a string **Client ID**. Codekeeper uses the **Client ID** (typically beginning `Iv`) for `CODEKEEPER_APP_CLIENT_ID`; the numeric App ID is not a substitute.

The App settings page also shows the App slug. Its publication login is `<app-slug>[bot]`; review setup asks for the slug and derives that login so App-authored review output can be identified. Provider and trace keys are single-line values entered at inherited `gh secret set` prompts; the terminal UI suspends while GitHub CLI owns the terminal, then redraws safely. The App private key is different: never paste the multiline PEM into a prompt. Select its downloaded file in the metadata-only picker before the final review. After confirmation, the installer opens it read-only and passes the descriptor directly to `gh secret set` with child output suppressed. PEM bytes are not put in command arguments, environment variables, installer buffers, generated files, terminal output, logs, plans, receipts, or snapshots. GitHub CLI reads the secret from standard input and encrypts it locally before submission. Never paste a key into `.github/codekeeper.json` or this installer.

The selected modes determine which provider secrets are requested. The `mixed` preset uses OpenAI for review, audit, and fix and DeepSeek for issue triage. The `openai` preset uses OpenAI for all selected modes. The bundled policies enable tracing, so both require a separate OpenAI trace key; a trace key is not the coordinator's provider key.

## Disabled defaults

The generated policy and all model/publication jobs are deliberately disabled:

- `CODEKEEPER_ENABLED=false`;
- audit repair is false;
- issue AI implementation is false;
- automatic exact-duplicate closure is false;
- auto-merge is false.

Caller triggers can still start their unconditional pinned-bootstrap jobs after the setup PR merges, including the maintenance schedule. Keep the setup PR unmerged until its triggers and source access are acceptable, and keep `CODEKEEPER_ENABLED=false` until controlled proof begins.

When pull-request review is installed, PR events also run the fail-closed `Codekeeper review gate`. It intentionally fails while `CODEKEEPER_ENABLED=false`. Do not add it to branch protection until a controlled review has passed with Codekeeper deliberately enabled.

Review protected paths, allowed repair paths, deterministic validation commands, owner logins, and `git diff --check` before merging. Enabling one control never implicitly enables another.

Review all four generated agent profiles as well. They are the intended quick-edit surface for judgment and writing behavior, but cannot weaken any deterministic control above.

## Change models

The bundled preset is a starting point, not an installer lock. Model changes belong in the generated `.github/codekeeper.json`; no installer-code change is required. For example, moving one OpenAI mode from Sol or Terra to Luna changes only the mode's `model` and matching `workspace.model` fields:

```json
{
  "ai": {
    "agents": {
      "review": {
        "model": "gpt-5.6-luna",
        "workspace": {
          "model": "gpt-5.6-luna"
        }
      }
    }
  }
}
```

Keep the existing surrounding policy fields. Changing provider as well as model can require a matching caller secret mapping and repository secret, so review the generated workflow before committing that change.

## Workflow lifecycle and records

| Stage | What happens | Durable record |
|---|---|---|
| Trigger | A selected caller receives a supported GitHub event or manual dispatch. | GitHub event and workflow run. |
| Pinned bootstrap | The caller fetches the runtime at the exact source SHA and verifies its manifest. | Workflow job and source reference. |
| Frozen decision | Trusted context and the selected policy/model are frozen before analysis. Repository content remains untrusted evidence. | Sealed run inputs and logs within their retention boundary. |
| Sealed artifact | Structured output and any bounded patch pass deterministic validation without App credentials. | Verified workflow artifact. |
| App publication | A separate job mints an installation token and publishes only validated output. | App-authored review, issue comment, label, or PR. |
| Evidence link | The operator retains the run, issue, and PR URLs plus private local acceptance evidence. | GitHub records and private evidence files. |

There is no hosted Codekeeper service, dashboard, webhook receiver, or central credential. GitHub issues, pull requests, Actions runs, and private local evidence are the system of record.

## Proof after the setup PR merges

Do not automatically exercise every selected mode. Keep `CODEKEEPER_ENABLED=false` until the repository is ready, deliberately set it to `true` for one bounded proof, then restore it to `false`. Use the smallest controlled proof for each selected mode:

| Mode | Next proof |
|---|---|
| Maintenance | Manually dispatch with `dry_run=true`; confirm a sealed artifact and no GitHub mutation. |
| Review | Open a controlled same-repository PR against the default branch and confirm the App-owned review and blocking gate. |
| Issues | Open or update a controlled issue and confirm bounded triage without a false duplicate closure. |
| Fix | Only after an owner deliberately sets `issues.allowAiImplementation=true`, use an owner-authorized command on a low-risk issue; confirm the PR is bounded and not auto-merged. |

Codekeeper v1 intentionally has no upgrade, overwrite, force, non-interactive, GHES, verify, automatic-enable, or automatic-merge command.
