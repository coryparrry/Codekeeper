# Codekeeper package

`codekeeper` is the complete Node.js release package for Codekeeper's versioned GitHub Actions workflows. It contains the installer and TUI, production runtime, default agents, presets, reusable workflows, and exact installer/runtime dependency graphs. Version `0.2.0` is published on npm. From a clean adopter checkout, `npx --yes codekeeper@0.2.0 init` resolves and runs the exact package receipt, then opens a terminal UI, creates a setup branch, pushes it, and opens a pull request. Use `npx --yes codekeeper@0.2.0 update` to advance the complete release-owned repository installation and runtime dependency pins. By default, the selected workflows start after the first pull request merges. You can choose a disabled install instead. The installer does not copy runtime source or dependencies into the adopter repository.

## Published CLI

The v1 CLI surface is:

```bash
npx --yes codekeeper@0.2.0 init
npx --yes codekeeper@0.2.0 update
npx --yes codekeeper@0.2.0 --help
npx --yes codekeeper@0.2.0 --version
```

The installer resolves and verifies the npm release receipt before running its locked CLI dependencies. Node.js 22 or newer, Git, and an authenticated current GitHub CLI are required. GitHub.com is the only supported host. The TUI uses the full terminal while setup runs. Use the arrow keys, Space, Enter, and Escape to move through it. Plain prompts remain the fallback for limited terminals. The `--help` and `--version` commands never start the TUI.

## Maintainer/recovery: local package testing

Adopters should use the published commands above. Maintainers can exercise an exact local tarball from a clean adopter checkout when testing a source release or recovering from registry unavailability. Use the `integrity` value returned by the same `npm pack --json` operation that created the tarball; do not calculate it from a different file or registry response.

```bash
npm exec --package /absolute/path/to/codekeeper-0.2.0.tgz -- codekeeper init --current-package --package-integrity 'sha512-...'
npm exec --package /absolute/path/to/codekeeper-0.2.0.tgz -- codekeeper update --current-package --package-integrity 'sha512-...'
```

## Document map

| Document | Purpose | When to use |
|---|---|---|
| This `README.md` | Installer boundary, prerequisites, generated setup, and operating model. | Before and during `codekeeper init`. |
| [Source installation guide](https://github.com/coryparrry/Codekeeper/blob/0cceb845ed7212d7f4d69fe7863d45f37647864d/INSTALL.md) | Full manual installation and credential boundaries at the pinned runtime checkpoint. | When auditing the generated setup or using the manual fallback. |
| Generated `.github/codekeeper.json` | Repository policy, model choices, protected paths, and startup controls. | Before merging the setup PR and whenever policy changes. |
| Generated `.github/codekeeper/README.md` | Release-owned explanation of the installed files and update commands. | When orienting maintainers inside an adopter repository. |
| Generated `.github/codekeeper-release.json` | Installed package/source version and inventory of release-managed files, with exact digests for copied artifacts and semantic validation for generated callers. | When reviewing an update that adds, replaces, renames, or removes generated callers. |
| Optional `.github/codekeeper/agents/*.md` overrides | Adopter-owned overrides for evidence, risk, duplicate, test-adequacy, and no-action judgment. Absent files use the packaged defaults. | Only when repository-specific behavior should differ from the release default. |
| Generated `.github/workflows/codekeeper-*.yml` and `.github/codekeeper/actions/acquire-package/action.yml` | Selected callers, local runtime workflows, and the exact-package acquisition action pinned to the npm version and SHA-512 integrity. | When reviewing triggers, permissions, package identity, or secret mappings. |
| [Packaged default profiles](https://github.com/coryparrry/Codekeeper/tree/0cceb845ed7212d7f4d69fe7863d45f37647864d/tools/codekeeper/agents) | Immutable source and provenance for the four defaults bundled with this release. | When comparing an optional repository override with the release baseline. |

## What `init` does

The Settings screen controls new and existing installations. Simple mode groups settings into tabs, with every role's provider, model, and effort on the first tab. Press `Tab` to change section, use Up and Down to move, use Left and Right for choices such as models and effort, and press Space for on/off settings. Press Enter on a model to see the full list or type another supported ID.

Profile instructions stay inside the TUI. Editing a profile creates a repository override for that role. Untouched defaults do not create files. Press `R` on a profile to remove its override and resume packaged updates. Press `A` for Advanced mode. Advanced uses the same section tabs and gives common values, such as response detail, clear choices instead of raw JSON. Protected release and safety boundaries stay fixed. Nothing changes until you accept the final review.

| Choice | What it adds |
|---|---|
| Pull request review | App-owned review output for controlled same-repository pull requests after Codekeeper is deliberately enabled. |
| Repository maintenance | Manual or scheduled audits. When repository repair is on, each live run can create one bounded repair pull request. |
| Issue triage | Issue-event labels and comments when enabled; not included in the starter selection. |
| Issue implementation and pull request repair | Automatically implements issues that triage marks ready when issue implementation is on. When this workflow is selected, an owner can also use `/codekeeper fix` to repair an existing pull request. |

The installer provides curated OpenAI, DeepSeek, and OpenRouter defaults and accepts any model ID for each provider. Coordinator selection is independent from the optional OpenAI Codex workspace specialist. OpenAI traces are optional. When traces are on, the installer requests a separate OpenAI Platform trace-export key. A ChatGPT subscription is not an API key.

After choosing the settings, the TUI shows one short summary of the repository, workflows, models, required credential names, file count, and startup choice. Select **Back to settings** to make another change. The installer then:

1. Generates `.github/codekeeper.json`, `.github/codekeeper-release.json`, the always-installed repository-assistant caller, and the selected role callers. It creates an `.github/codekeeper/agents/*.md` file only for a profile explicitly edited in Settings.
2. Keeps every generated caller pinned to one exact package version and npm SHA-512 integrity. The first runtime job verifies the registry tarball and shares it as a run-scoped artifact; every later isolated job reverifies the artifact before trusting its closed manifest or runtime.
3. Opens a prefilled GitHub App registration page. The adopter creates and installs the App. Codekeeper hosts no callback. Paste the saved App settings URL into the TUI. Codekeeper extracts the bot name.
4. Before the final confirmation, shows only usable `.pem` key files from Downloads. The newest keys are first. It hides folders, other files, and links. It does not read the key or display its path.
5. Sets `CODEKEEPER_ENABLED` from your startup choice. The terminal UI accepts each API key and sends it directly to `gh secret set` through standard input. It sends the App key file to `gh` through a file descriptor.
6. Creates `codekeeper/setup`, stages only generated paths, commits `chore(codekeeper): add setup`, pushes the branch, and creates a setup pull request. The TUI then opens the pull request in the browser.

It never merges the pull request, runs a workflow, copies the runtime, or creates a hosted service.

## Change an existing installation

Run `npx --yes codekeeper@0.2.0 init` again from the current default branch to edit settings. The installer loads the current workflows, callers, schedule, GitHub App settings, policy, model choices, and repository profile overrides into the same Settings screen. Missing overrides display the current packaged defaults. You can add or remove role workflows, change every editable policy value, edit profiles inside the TUI, or press `R` to restore the default profile.

The installer writes only values that changed. It preserves every untouched profile override. It does not ask for existing secrets again. Press `R` to remove an override. Editing one default creates only that role's override. A settings change opens a `codekeeper/update-<commit>` pull request. A change to only `CODEKEEPER_ENABLED` updates the repository variable without opening a pull request. If nothing changed, the installer exits without writing.

## Update an existing installation

Run `npx --yes codekeeper@0.2.0 update` from a clean, current default-branch checkout. The command resolves the registry's current `latest` version and `dist.integrity` together, launches that exact package with install scripts disabled, and refuses a missing, malformed, or mismatched receipt. The update refreshes every release-owned caller, local package action/runtime workflow, provider definition, policy/schema safety boundary, and generated-file inventory. New generated files are added and retired release-owned files are removed in the same reviewed pull request after preflight validates their ownership and binds the plan to the exact inspected bytes. Existing source-pinned installations migrate to package execution through that pull request; the historical commit remains valid until it merges.

The published tarball is the update boundary. New CLI and TUI modules come from `packages/codekeeper`. New runtime modules, agent tools, profiles, and presets come from their approved production roots. The package verifier rejects missing, extra, changed, hidden, or linked files. One strict artifact catalog controls repository-installed files. The `.github/codekeeper-release.json` file records their inventory. Each copied Markdown, settings, or workflow asset needs one catalog record. The record defines its destination, owner, activation, renderer, validation rule, and purpose. The existing systems then add or update it. Renames list the previous target. Removal records stay until every supported installation has migrated.

An update from a release that used the retired alternate trace exporter needs one explicit choice before merge: configure `OPENAI_TRACE_API_KEY`, or disable tracing in `.github/codekeeper.json`. After the update merges, remove any now-ignored alternate-exporter variables and secrets from the repository.

The update preserves adopter-owned selections and data: selected workflows, repository settings, model and automation choices, GitHub variables and secrets, and existing profile overrides. A repository with no overrides stays that way; new packaged defaults arrive with the runtime instead of creating adopter files. The TUI shows the exact changed files before creating an update pull request. Codekeeper keeps running the current default-branch release until that pull request merges. If the installation already uses the release bundled with the latest CLI, the command exits successfully without writing. `update --current-package` skips registry bootstrapping only for exact local-tarball and offline release testing.

## Editable agent behavior

Every release includes four fixed, versioned packaged defaults:

- `.github/codekeeper/agents/pr-reviewer.md`
- `.github/codekeeper/agents/repository-auditor.md`
- `.github/codekeeper/agents/issue-triager.md`
- `.github/codekeeper/agents/fixer.md`

New installations do not copy these files into the adopter repository. The runtime uses the packaged default while the corresponding repository path is absent. Editing a profile in Settings creates that one optional override. Review an override through an ordinary pull request; after merge, its trusted default-branch bytes tune priorities, work selection, implementation approach, review standards, evidence thresholds, duplicate criteria, risk decisions, writing, and when the right result is no action.

Profiles control how an agent does its selected job. Capability switches control what GitHub actions it may take. Profiles cannot enable a disabled capability, change an event trigger, expand allowed paths, remove protected paths, expose a secret, or change GitHub App permissions.

When repository repair is on, a live maintenance run may make one bounded repair. When issue implementation is on, trusted triage can mark an issue ready and start implementation. The `CODEKEEPER_ENABLED` repository variable turns the whole installation on or off. A repair requested on an existing same-repository pull request stays on that pull request's current head branch; it does not open a second pull request.

## Preflight and safe failure

`init` refuses to mutate the checkout when any prerequisite is unsafe or ambiguous. Rejections include:

- a missing or unauthenticated `gh`, GitHub Enterprise Server, or missing repository admin access;
- a dirty checkout, detached `HEAD`, stale local checkout, or a `HEAD` that is not the remote default branch;
- an incomplete existing Codekeeper installation, an existing setup or update branch for the same source commit, or a generated-file collision.

The same collision checks reserve all four optional profile paths and every parent directory. Case-colliding paths, symlinked parents, and symlinked profile targets fail before any generated file is written. A genuinely absent profile is valid.

If setup fails, follow the recovery command printed by the installed binary. The installer preserves recoverable branch or pull-request state. Do not merge a partial setup.

## GitHub App and secret boundary

The GitHub App needs contents, issues, and pull requests read-write plus metadata read-only, with webhooks disabled. Its settings page shows both a numeric **App ID** and a string **Client ID**. Codekeeper uses the **Client ID** (typically beginning `Iv`) for `CODEKEEPER_APP_CLIENT_ID`; the numeric App ID is not a substitute.

The App settings URL ends with the App URL name. For example, `github.com/settings/apps/my-codekeeper-app` uses `my-codekeeper-app`. Paste this URL during setup. Codekeeper then derives `my-codekeeper-app[bot]`.

Paste API keys into the Codekeeper terminal UI and press Enter. Codekeeper sends each key directly to `gh secret set` through standard input. It does not put the value in command arguments, environment variables, generated files, output, plans, receipts, or snapshots.

Do not paste the multiline App private key. Select its downloaded `.pem` file before the final review. The installer opens it read-only and passes its descriptor directly to `gh secret set`. It does not read or display the key or its path.

The selected role assignments determine which provider secrets are requested. OpenAI, DeepSeek, and OpenRouter use `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `OPENROUTER_API_KEY` respectively. An enabled OpenAI workspace specialist still needs `OPENAI_API_KEY` when its coordinator uses another provider. Tracing uses a separate OpenAI trace key. A same-provider model change does not request that provider key again.

## Capability choices

The installer enables the selected workflows after merge by default. You can choose a disabled install instead. It also shows every capability that applies to your workflows:

- repository repair;
- issue implementation;
- automatic exact-duplicate closure;
- automatic merge.

Automatic review, feedback triage, issue triage, owner requests, and deferred-issue creation start on when their callers are installed. Automatic code repair, issue implementation, duplicate closure, and merge remain off until enabled separately. The final review gives a short summary of the selected workflows, models, file count, and required secret names before the installer changes repository settings or files.

Review all triggers before you merge the setup pull request. If you chose a disabled installation, keep the `Codekeeper review gate` optional until Codekeeper is enabled.

Review protected paths, allowed repair paths, deterministic validation commands, owner logins, and `git diff --check` before merging. Enabling one control never implicitly enables another.

Review any repository profile overrides as well. The packaged defaults need no adopter file, and neither defaults nor overrides can weaken any deterministic control above.

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

The installer renders the policy, caller controls, schedule, and credential mappings from one validated settings object in one pull request.

## Workflow lifecycle and records

| Stage | What happens | Durable record |
|---|---|---|
| Trigger | A selected caller receives a supported GitHub event or manual dispatch. | GitHub event and workflow run. |
| Exact package acquisition | Each isolated runtime job fetches the pinned npm tarball and verifies its integrity, manifest, inventory, and source commit. | Workflow job and package receipt. |
| Frozen decision | Trusted context and the selected policy/model are frozen before analysis. Repository content remains untrusted evidence. | Sealed run inputs and logs within their retention boundary. |
| Sealed artifact | Structured output and any bounded patch pass deterministic validation without App credentials. | Verified workflow artifact. |
| App publication | A separate job mints an installation token and publishes only validated output. | App-authored review, issue comment, label, or PR. |
| Evidence link | The operator retains the run, issue, and PR URLs plus private local acceptance evidence. | GitHub records and private evidence files. |

There is no hosted Codekeeper service, dashboard, webhook receiver, or central credential. GitHub issues, pull requests, Actions runs, and private local evidence are the system of record.

## After the setup PR merges

An enabled installation starts its selected workflows after the setup pull request merges. An update keeps running the current default-branch settings until its pull request merges. It then uses the updated settings. No separate dry run or controlled test is required.

If you chose a disabled installation, Codekeeper stays off until you set `CODEKEEPER_ENABLED=true`. Keep the review gate optional while Codekeeper is disabled.

Codekeeper v1 has no force, non-interactive, GHES, or separate verify command.
