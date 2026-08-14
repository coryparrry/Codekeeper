# Codekeeper installer

`codekeeper` is the Node.js installer and configuration editor for Codekeeper's versioned GitHub Actions workflows. `npx codekeeper init` opens a terminal UI, creates a setup or update branch, pushes it, and opens a pull request. By default, the selected workflows start after the first pull request merges. You can choose a disabled install instead. The installer does not copy the private runtime into the adopter repository.

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
| [Source installation guide](https://github.com/coryparry/Codekeeper/blob/5f79f1df3566a5d876d0e7a86d55c95170905cda/INSTALL.md) | Full manual installation and credential boundaries at the pinned runtime checkpoint. | When auditing the generated setup or using the manual fallback. |
| Generated `.github/codekeeper.json` | Repository policy, model choices, protected paths, and startup controls. | Before merging the setup PR and whenever policy changes. |
| Generated `.github/codekeeper/agents/*.md` | Adopter-editable evidence, risk, duplicate, test-adequacy, and no-action judgment for all four agents. | When tuning how Codekeeper reasons about repository evidence. |
| Generated `.github/workflows/codekeeper-*.yml` | Selected callers pinned to the exact tested Codekeeper source commit. | When reviewing triggers, permissions, or secret mappings. |
| [Canonical starter profiles](https://github.com/coryparry/Codekeeper/tree/5f79f1df3566a5d876d0e7a86d55c95170905cda/tools/codekeeper/agents) | Immutable source and provenance for the four starter Markdown files copied by this installer. | When comparing local profile changes with the release baseline. |

## What `init` does

The Settings screen is the command centre for both new and existing installations. Standard mode covers workflows, autonomy, schedules, every role's provider/model/effort, workspace specialists, tracing, and all four profiles. Press `A` for Advanced mode, which exposes every editable policy field and shows immutable safety and release boundaries as read-only. Nothing changes until the final review is accepted.

| Choice | What it adds |
|---|---|
| Pull request review | App-owned review output for controlled same-repository pull requests after Codekeeper is deliberately enabled. |
| Repository maintenance | Manual or scheduled audits. When repository repair is on, each live run can create one bounded repair pull request. |
| Issue triage | Issue-event labels and comments when enabled; not needed for the starter proof. |
| Issue implementation and pull request repair | Automatically implements issues that triage marks ready when issue implementation is on. When this workflow is selected, an owner can also use `/codekeeper fix` to repair an existing pull request. |

The installer provides curated OpenAI, DeepSeek, and OpenRouter defaults and accepts any model ID for each provider. Coordinator selection is independent from the optional OpenAI Codex workspace specialist. OpenAI traces are optional. When traces are on, the installer requests a separate OpenAI Platform trace-export key. A ChatGPT subscription is not an API key.

After choosing the starter or custom path, the flow explains that the display name appears only in Codekeeper's GitHub comments and that owner logins control owner-only commands. It then confirms conservative policy invariants and:

1. Generates `.github/codekeeper.json`, all four editable profiles under `.github/codekeeper/agents/`, the always-installed repository-assistant caller, and the selected role callers.
2. Keeps every reusable-workflow and bootstrap reference pinned to source commit `5f79f1df3566a5d876d0e7a86d55c95170905cda`.
3. Prints and best-effort opens the prefilled GitHub App registration page. The adopter creates and installs the App; Codekeeper hosts no callback.
4. Before the final confirmation, shows only usable `.pem` key files from Downloads. The newest keys are first. It hides folders, other files, and links. It does not read the key or display its path.
5. Sets `CODEKEEPER_ENABLED` from your startup choice. The terminal UI accepts each API key and sends it directly to `gh secret set` through standard input. It sends the App key file to `gh` through a file descriptor.
6. Creates `codekeeper/setup`, stages only generated paths, commits `chore(codekeeper): add setup`, pushes the branch, and opens a setup pull request.

It never merges the pull request, runs a workflow, publishes an npm package, copies the runtime, or creates a hosted service.

## Change an existing installation

Run `npx codekeeper init` again from the current default branch. The installer loads the current workflows, callers, schedule, GitHub App settings, policy, model choices, and edited profiles into the same Settings screen. You can add or remove role workflows, change every editable policy value, and open any profile in `$EDITOR` without losing prior customizations.

The installer writes only values that changed. It preserves edited profiles and does not ask for secrets again. A configuration change opens a `codekeeper/update-<commit>` pull request. A change to only `CODEKEEPER_ENABLED` updates the repository variable without opening a pull request. If nothing changed, the installer exits without writing.

## Editable agent behavior

Every installation includes these fixed, versioned starter files:

- `.github/codekeeper/agents/pr-reviewer.md`
- `.github/codekeeper/agents/repository-auditor.md`
- `.github/codekeeper/agents/issue-triager.md`
- `.github/codekeeper/agents/fixer.md`

Edit and review these Markdown files through an ordinary pull request. After merge, their trusted default-branch versions tune priorities, work selection, implementation approach, review standards, evidence thresholds, duplicate criteria, risk decisions, writing, and when the right result is no action.

Profiles control how an agent does its selected job. Capability switches control what GitHub actions it may take. Profiles cannot enable a disabled capability, change an event trigger, expand allowed paths, remove protected paths, expose a secret, or change GitHub App permissions.

When repository repair is on, a live maintenance run may make one bounded repair. When issue implementation is on, trusted triage can mark an issue ready and start implementation. The `CODEKEEPER_ENABLED` repository variable turns the whole installation on or off. A repair requested on an existing same-repository pull request stays on that pull request's current head branch; it does not open a second pull request.

## Preflight and safe failure

`init` refuses to mutate the checkout when any prerequisite is unsafe or ambiguous. Rejections include:

- a missing or unauthenticated `gh`, GitHub Enterprise Server, or missing repository admin access;
- a dirty checkout, detached `HEAD`, stale local checkout, or a `HEAD` that is not the remote default branch;
- an incomplete existing Codekeeper installation, an existing setup or update branch for the same source commit, or a generated-file collision.

The same collision checks cover all four agent profiles and every parent directory. Case-colliding paths, symlinked parents, and symlinked profile targets fail before any generated file is written.

If setup fails, follow the recovery command printed by the installed binary. The installer preserves recoverable branch or pull-request state. Do not merge a partial setup.

## GitHub App and secret boundary

The GitHub App needs contents, issues, and pull requests read-write plus metadata read-only, with webhooks disabled. Its settings page shows both a numeric **App ID** and a string **Client ID**. Codekeeper uses the **Client ID** (typically beginning `Iv`) for `CODEKEEPER_APP_CLIENT_ID`; the numeric App ID is not a substitute.

The App settings URL ends with the App URL name. For example, `github.com/settings/apps/my-codekeeper-app` uses `my-codekeeper-app`. Review setup asks for this name and derives `my-codekeeper-app[bot]`.

Paste API keys into the Codekeeper terminal UI and press Enter. Codekeeper sends each key directly to `gh secret set` through standard input. It does not put the value in command arguments, environment variables, generated files, output, plans, receipts, or snapshots.

Do not paste the multiline App private key. Select its downloaded `.pem` file before the final review. The installer opens it read-only and passes its descriptor directly to `gh secret set`. It does not read or display the key or its path.

The selected role assignments determine which provider secrets are requested. OpenAI, DeepSeek, and OpenRouter use `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `OPENROUTER_API_KEY` respectively. An enabled OpenAI workspace specialist still needs `OPENAI_API_KEY` when its coordinator uses another provider. Tracing uses a separate OpenAI trace key. A same-provider model change does not request that provider key again.

## Capability choices

The installer enables the selected workflows after merge by default. You can choose a disabled install instead. It also shows every capability that applies to your workflows:

- repository repair;
- issue implementation;
- automatic exact-duplicate closure;
- automatic merge.

Automatic review, feedback triage, issue triage, owner requests, and deferred-issue creation start on when their callers are installed. Automatic code repair, issue implementation, duplicate closure, and merge remain off until enabled separately. The final review shows effective automation, changed files, variables, and required secrets before the installer changes repository settings or files.

Review all triggers before you merge the setup pull request. Do not add the `Codekeeper review gate` to branch protection until a controlled review passes.

Review protected paths, allowed repair paths, deterministic validation commands, owner logins, and `git diff --check` before merging. Enabling one control never implicitly enables another.

Review all four generated agent profiles as well. They are the intended quick-edit surface for judgment and writing behavior, but cannot weaken any deterministic control above.

## Change models

The bundled preset is a starting point, not an installer lock. Change provider, arbitrary model ID, effort, model settings, and the independently configured workspace specialist in the Settings screen. For example, changing the review coordinator does not silently rewrite its workspace model:

```json
{
  "ai": {
    "agents": {
      "review": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.5",
        "effort": "none",
        "workspace": {
          "model": "gpt-5.6-sol"
        }
      }
    }
  }
}
```

The installer renders the policy, caller controls, schedule, and provider-secret mappings from that one validated settings object in a single configuration pull request.

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
| Fix | Use a controlled issue that triage marks ready and confirm that implementation opens a bounded pull request. Use `/codekeeper fix` only to test repair on an existing pull request. |

Codekeeper v1 has no force, non-interactive, GHES, or separate verify command.
