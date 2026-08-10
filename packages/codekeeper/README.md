# Codekeeper installer

`codekeeper` is the Node.js installer for Codekeeper's versioned GitHub Actions workflows. `npx codekeeper init` opens a terminal UI, creates a setup branch, pushes it, and opens a setup pull request. By default, the selected workflows start after that pull request merges. You can choose a disabled install instead. The installer does not copy the private runtime into the adopter repository.

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
| [Source installation guide](https://github.com/coryparrry/Codekeeper/blob/38c0306a78888346208aae992a0786d7414e3c0a/INSTALL.md) | Full manual installation and credential boundaries at the pinned runtime checkpoint. | When auditing the generated setup or using the manual fallback. |
| Generated `.github/codekeeper.json` | Repository policy, model choices, protected paths, and startup controls. | Before merging the setup PR and whenever policy changes. |
| Generated `.github/codekeeper/agents/*.md` | Adopter-editable evidence, risk, duplicate, test-adequacy, and no-action judgment for all four agents. | When tuning how Codekeeper reasons about repository evidence. |
| Generated `.github/workflows/codekeeper-*.yml` | Selected callers pinned to the exact tested Codekeeper source commit. | When reviewing triggers, permissions, or secret mappings. |
| [Canonical starter profiles](https://github.com/coryparrry/Codekeeper/tree/38c0306a78888346208aae992a0786d7414e3c0a/tools/codekeeper/agents) | Immutable source and provenance for the four starter Markdown files copied by this installer. | When comparing local profile changes with the release baseline. |

## What `init` does

The recommended setup includes pull-request review, repository maintenance, and the `openai` preset. It does not include issue triage or issue fix. The installer then asks if Codekeeper starts after the setup pull request merges. The default answer is enabled. Choose custom setup to select different workflows or use DeepSeek for issue triage.

| Choice | What it adds |
|---|---|
| Pull request review | App-owned review output for controlled same-repository pull requests after Codekeeper is deliberately enabled. |
| Repository maintenance | Manual or scheduled audits; the first proof is a manual `dry_run=true` run with no GitHub mutation. |
| Issue triage | Issue-event labels and comments when enabled; not needed for the starter proof. |
| Owner-authorized issue fix | A repair pull-request path that requires an owner command. The installer asks if issue implementation is on. |

The `openai` preset uses one OpenAI Platform provider key for every selected workflow. The `mixed` preset uses DeepSeek only for issue triage and OpenAI for the others, so selecting issue triage can require both provider keys. Both presets also request a separate OpenAI Platform trace-export key and the downloaded GitHub App PEM private key. A ChatGPT subscription is not an API key. Changing a model later is a small `.github/codekeeper.json` edit, not an installer change; the final preview shows each exact provider, model, and effort before mutation.

After choosing the starter or custom path, the flow explains that the display name appears only in Codekeeper's GitHub comments and that owner logins control owner-only commands. It then confirms conservative policy invariants and:

1. Generates `.github/codekeeper.json`, all four editable profiles under `.github/codekeeper/agents/`, and only the selected caller workflows.
2. Keeps every reusable-workflow and bootstrap reference pinned to source commit `38c0306a78888346208aae992a0786d7414e3c0a`.
3. Prints and best-effort opens the prefilled GitHub App registration page. The adopter creates and installs the App; Codekeeper hosts no callback.
4. Before the final confirmation, shows only usable `.pem` key files from Downloads. The newest keys are first. It hides folders, other files, and links. It does not read the key or display its path.
5. Sets `CODEKEEPER_ENABLED` from your startup choice. The terminal UI accepts each API key and sends it directly to `gh secret set` through standard input. It sends the App key file to `gh` through a file descriptor.
6. Creates `codekeeper/setup`, stages only generated paths, commits `chore(codekeeper): add setup`, pushes the branch, and opens a setup pull request.

It never merges the pull request, runs a workflow, publishes an npm package, copies the runtime, or creates a hosted service.

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

If setup fails, follow the recovery command printed by the installed binary. The installer preserves recoverable branch or pull-request state. Do not merge a partial setup.

## GitHub App and secret boundary

The GitHub App needs contents, issues, and pull requests read-write plus metadata read-only, with webhooks disabled. Its settings page shows both a numeric **App ID** and a string **Client ID**. Codekeeper uses the **Client ID** (typically beginning `Iv`) for `CODEKEEPER_APP_CLIENT_ID`; the numeric App ID is not a substitute.

The App settings URL ends with the App URL name. For example, `github.com/settings/apps/my-codekeeper-app` uses `my-codekeeper-app`. Review setup asks for this name and derives `my-codekeeper-app[bot]`.

Paste API keys into the Codekeeper terminal UI and press Enter. Codekeeper sends each key directly to `gh secret set` through standard input. It does not put the value in command arguments, environment variables, generated files, output, plans, receipts, or snapshots.

Do not paste the multiline App private key. Select its downloaded `.pem` file before the final review. The installer opens it read-only and passes its descriptor directly to `gh secret set`. It does not read or display the key or its path.

The selected modes determine which provider secrets are requested. The `mixed` preset uses OpenAI for review, audit, and fix and DeepSeek for issue triage. The `openai` preset uses OpenAI for all selected modes. The bundled policies enable tracing, so both require a separate OpenAI trace key; a trace key is not the coordinator's provider key.

## Capability choices

The installer enables the selected workflows after merge by default. You can choose a disabled install instead. It also shows every capability that applies to your workflows:

- repository repair;
- issue implementation;
- automatic exact-duplicate closure;
- automatic merge.

Applicable capabilities are selected by default. Clear any capability that you do not want. The final review shows each capability as on or off before the installer changes repository settings or files.

Review all triggers before you merge the setup pull request. Do not add the `Codekeeper review gate` to branch protection until a controlled review passes.

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

If you chose the enabled install, Codekeeper starts after the setup pull request merges. Test each selected mode before you make its check required. If you chose the disabled install, set `CODEKEEPER_ENABLED=true` when you are ready to test.

| Mode | Next proof |
|---|---|
| Maintenance | Manually dispatch with `dry_run=true`; confirm a sealed artifact and no GitHub mutation. |
| Review | Open a controlled same-repository PR against the default branch and confirm the App-owned review and blocking gate. |
| Issues | Open or update a controlled issue and confirm bounded triage without a false duplicate closure. |
| Fix | Only after an owner deliberately sets `issues.allowAiImplementation=true`, use an owner-authorized command on a low-risk issue; confirm the PR is bounded and not auto-merged. |

Codekeeper v1 has no upgrade, overwrite, force, non-interactive, GHES, verify, or automatic-merge command.
