# Architecture

Codekeeper is distributed as one versioned npm package containing the installer, runtime, default agents, and reusable workflows. An adopter keeps its event triggers, policy, and small local reusable-workflow entrypoints in its own repository. There is no shared database, webhook service, or hosted App.

```text
Adopter event, default-branch policy, and exact package receipt
        |
        v
Local runtime workflow starts its independent jobs in parallel
        |
        +-- first runtime job acquires one exact npm package
        +-- later isolated jobs reverify its run-scoped artifact
        |     - verifies SHA-512, closed manifest, inventory, hashes, and source commit
        |     - rejects links and hidden paths before installing the locked runtime
        |
        +-- workspace specialist: optional workspace key and read-only GitHub token
        |     - frozen policy, exact-head context, bounded review diff, and schema
        |     - optional single Codex workspace specialist
        |     - untrusted specialist result and, for audit/fix, patch artifact
        |
        +-- coordinator (fresh runner): provider and optional trace keys; no workspace or App key
        |     - reconstructs its own frozen bundle from trusted inputs
        |     - one tool-less Agents SDK coordinator selected per mode with its versioned profile
        |     - applies an audit/fix untrusted patch only after model execution
        |     - deterministic result validation and structured candidate artifact
        |
        +-- verification (repairs only): no credentials
        |     - fresh checkout and patch validation
        |
        +-- sealing: no credentials
        |     - immutable candidate and context hashes
        |
        +-- publication: short-lived adopter App token, no provider, trace, or workspace key
              - labels, comments, issues, repair PRs, auto-merge
```

## Trust boundaries

The generated caller pins an exact npm package version and SHA-512 integrity, then invokes the adopter's local runtime workflow directly. The first runtime job uses the repository-owned acquisition action to download the exact tarball and verify its SHA-512, manifest identity, source commit, exact inventory, file hashes, and absence of links or hidden paths. It uploads the verified package as a one-day, run-scoped artifact. Every later isolated job downloads and independently reverifies the artifact before installing the nested locked runtime dependency graph. The jobs do not wait for a separate serial package-bootstrap job. Only then may the Codekeeper CLI run. The local reusable workflow uses `job.workflow_sha` for adopter-workflow provenance and reads policy only from the adopter default branch. The review caller is a default-branch `pull_request_target` definition that only invokes local reusable workflows; it never checks out or executes PR code. Pull request heads, issue data, comments, repository files, package downloads before verification, and model output are untrusted.

### Legacy source-pinned compatibility

Installations created before the package-execution release may still call a historical Codekeeper action and reusable workflow by one full source commit. Those immutable revisions continue to use the source manifest and one-day tooling artifact recorded at that commit. `codekeeper update` migrates the repository to the package receipt and local-workflow model; the legacy path is compatibility behavior, not the primary release architecture.

### Release inventory and repository artifact catalog

The release has three explicit delivery planes:

1. The npm package recursively carries the CLI, TUI, package assets, verification code, and lightweight dependency graph.
2. The package's nested runtime recursively carries production source, agent tools and Markdown, presets, reusable workflows, and the locked runtime dependency graph.
3. [`repository-artifacts.mjs`](../packages/codekeeper/src/repository-artifacts.mjs) declares every managed payload file that the installer may place in an adopter repository. The generated `.github/codekeeper-release.json` control record is the separate ledger envelope for that payload.

The first two planes use closed manifests, so an added production file inside an approved root enters the next package automatically and an omitted, extra, changed, hidden, or symlinked file fails verification. The repository plane cannot safely infer destinations from source paths. Each payload artifact therefore has one reviewed stable ID, fixed target, ownership class, activation rule, registered renderer, validation rule, and purpose. The renderer, release-ledger contents, preflight, planner, and TUI consume that same catalog; the ledger envelope itself remains fixed control metadata rather than claiming ownership over itself.

Release-owned copied artifacts are digest-bound. Generated callers instead receive semantic validation so supported adopter controls survive updates; every planned deletion is still bound to the exact inspected bytes. A release can add or update a copied artifact by changing catalog data and its asset. A rename lists the prior target; a retirement keeps an explicit release-owned tombstone until every supported installation can delete the old target. Mixed policy and adopter-owned profile overrides retain their specialized preservation rules. Catalog targets are limited to the Codekeeper-owned `.github` namespaces, so neither a package nor an installed manifest can claim arbitrary repository files.

The workspace specialist and coordinator are separate jobs on fresh GitHub-hosted Ubuntu runners. Product workflows use the literal `ubuntu-latest` runner for every job; custom or persistent self-hosted runner overrides are deliberately not part of the supported adopter surface. This keeps untrusted workspace inspection from sharing a persistent machine with coordinator, verification, or publication jobs that handle credentials. The workspace job launches the pinned Codex CLI as a local stdio MCP server through the Agents SDK; there is no separately hosted MCP service or Codex GitHub Action. The MCP host receives only its workspace credential and passes a minimal environment to Codex, while Codex's shell policy excludes secret variables from spawned commands. It never receives the provider, trace, or App credential. The coordinator rebuilds its frozen bundle from trusted checkouts and must match that bundle’s context digest to the workspace job output before reading specialist data. It reads only the specialist JSON result and, for write-capable audit/fix modes, a patch artifact as untrusted evidence; it rejects non-regular artifact files and applies that patch only after the model call completes.

The workspace specialist receives the full frozen task prompt and produces bounded evidence. A review normally makes one workspace call. If that Medium result contains a current, high-confidence, blocking `high` or `critical` finding at a concrete line in the frozen changed-file list, the same MCP session makes one focused Max call in the same checkout. Overall risk, proposed labels, general security language, non-blocking findings, and unlocated findings cannot trigger that call. The Max result replaces the Medium result rather than being merged with it. Reviews pre-routed to Max from trusted labels, configured paths, or change-size thresholds make only their original Max call.

When a specialist finishes, the coordinator receives a separate compact prompt containing only target metadata, policy constraints, and the final specialist evidence; every emitted claim must be copied from that result. It may omit optional evidence or choose a strictly more conservative enum state, but cannot add or rewrite findings, commands, tests, implementation claims, maintainer decisions, comments, summaries, repair metadata, or explanatory reasons. A specialist-required maintainer decision must remain required, so it cannot be bypassed by an `ai-ready` result. Issue triage uses the full bounded issue context only when its specialist is disabled. Workspace-disabled review, audit, and fix modes return deterministic fail-safe results without a provider call. Coordinators run for one turn and omit textual schemas when the provider enforces structured output. Before the prompt runs, the runtime selects one versioned Markdown profile for `Agent.instructions`: the verified packaged default, or the coordinator's fixed `.github/codekeeper/agents/*.md` path from the adopter default branch when that optional override exists. It records the source identity and SHA-256, freezes the selected bytes for the workspace and coordinator, and revalidates them before publication. The profile states its output responsibilities and boundaries; the shared instructions retain the no-tool security contract. The coordinator has no independent shell, filesystem, GitHub, credential, or arbitrary network tools. Candidate artifacts hash and retain the context, result, per-pass workspace timings, runtime usage and cache metadata, validation record, and optional patch; a later credential-free job validates repair patches again in a fresh checkout. A final job mints the adopter GitHub App token and publishes only the sealed artifact. It does not execute adopter repository code.

Every Codex workspace uses a fresh runner-owned `CODEX_HOME` with `project_doc_max_bytes=0`, fallback project documents disabled, and automatic skill instructions disabled. Because pinned Codex independently discovers repository skills, `.agents/skills` and `.codex/skills` are moved into a runner-owned quarantine for the model invocation and restored before patch capture. Any replacement instruction surface created during the run fails the job.

| Coordinator | Packaged default | Optional adopter override |
|---|---|---|
| Pull request reviewer | `tools/codekeeper/agents/pr-reviewer.md` | `.github/codekeeper/agents/pr-reviewer.md` |
| Issue triager | `tools/codekeeper/agents/issue-triager.md` | `.github/codekeeper/agents/issue-triager.md` |
| Repository auditor | `tools/codekeeper/agents/repository-auditor.md` | `.github/codekeeper/agents/repository-auditor.md` |
| Fixer | `tools/codekeeper/agents/fixer.md` | `.github/codekeeper/agents/fixer.md` |

The selected provider’s `model_api_key` is required for analysis and never falls back to an OpenAI key. Codex may use `workspace_api_key` or its legacy `openai_api_key` compatibility fallback because it requires OpenAI. OpenAI trace export uses a distinct `trace_api_key` that exists only in the fresh coordinator job, never the Codex workspace or publication job. The trace exporter may not reuse a model-provider key. The starter policy keeps sensitive trace data off by default.

Labels and sticky comments are owned only when both their marker and configured App bot identity match. Maintenance fingerprints and repair-PR markers use the same identity check, avoiding a separate state store.

## Policy validation seam

The production runtime owns the complete version 3 policy contract in `tools/codekeeper/src/lib/policy-validator.mjs`. Both file loading and the guided installer call its loader-independent `validatePolicy` boundary, so accepted object keys, relationships, bounds, schedules, labels, providers, agents, and safety constraints cannot drift between setup and execution. The unified npm release stage contains the canonical runtime and a generated byte-identical installer copy; repository checks fail if that copy differs. Generated callers invoke local reusable workflows. The first job downloads and verifies the exact package version. Later isolated jobs independently reverify its run-scoped artifact and install the nested locked runtime graph without lifecycle scripts. Existing source-pinned Actions remain valid at their historical commit until the adopter merges a generated package-migration update.

Installer validation adds only installation-context constraints: immutable safety fields cannot be edited, enabled capabilities must have their executing workflows, model providers must have an installer credential mapping, and edited profile overrides must be bounded Markdown. These checks do not redefine the runtime policy schema.

## Conditional GitHub mutation seam

Review publication opens one conditional pull mutation in the GitHub adapter. The adapter captures the live label set and binds it to the sealed repository, head SHA, base SHA/ref, and policy-filtered feedback hash. Every REST write and GraphQL mutation then re-reads and compares that state inside the transport seam before sending the write. Successful Codekeeper label mutations advance only the adapter's expected label state; a rollback can remove only a label that the same conditional mutation added.

GitHub does not provide a transaction or compare-and-swap precondition spanning pull metadata, reviews, comments, labels, and repository dispatch. A remote change can therefore still land after the adapter's final comparison and before GitHub accepts the immediately following write. That final request-sized race is an explicit platform limitation, not a defect to address with additional caller-side reads. Codekeeper fails closed for every drift it observes at the mutation seam, and postconditions remain responsible only for proving the result of a mutation such as auto-merge activation.

## Review gate and auto-merge

The reusable review workflow exposes a PR-native, fail-closed gate in the same trusted post-seal job as publication, avoiding a serial runner allocation without combining the workspace, coordinator, seal, or App-token trust boundaries. The gate step always runs and passes only after analysis, sealing, and publication succeed for the supported PR shape. It is not an external commit-status publisher.

Auto-merge is separately evaluated from the model recommendation. It requires an allowed author or automation branch, same-repository open non-draft PR, low risk, adequate tests, no blocking findings, complete frozen review-diff context, and the configured file, line, and path limits. A later ineligible review attempts to remove stale auto-merge.

## Supported shape

This design is GitHub.com-only because it depends on reusable-workflow identity fields not available on GitHub Enterprise Server. The review gate supports non-draft, same-repository PRs. A PR aimed at another same-repository branch receives review publication, but automatic repair and auto-merge remain restricted to the configured default branch. Forks, drafts, and disabled runs fail closed. The supplied caller does not trigger `merge_group`, so its gate must not be required for merge queues.

Automatic issue triage is restricted to caller-enabled `issues` events for `opened`, `reopened`, and `edited` actions. The workflow records trusted automatic/manual mode in frozen context instead of inferring it from issue text. Automatic publication may add labels, a sticky triage comment, and a duplicate label. With `issues.closeResolvedIssues=true`, it closes an issue as completed only when GitHub authoritatively links a merged closing pull request, then revalidates that frozen reference before mutation. Closing an exact duplicate remains separately controlled by default-false `issues.closeExactDuplicates`. Exact owner triage comments and all fixes require an eligible caller association plus a login in `repository.ownerLogins`; manual fixes use the same policy check.

## Validation process boundary

Repair validation runs only on the supplied ephemeral GitHub-hosted Ubuntu runner. The product workflow hard-codes `ubuntu-latest` so an adopter cannot route validation or any adjacent credential-bearing job onto a persistent self-hosted machine. One process supervisor owns the command deadline, bounded output tails, launch process group, observable descendants, and `SIGTERM`-then-`SIGKILL` escalation; validation callers do not implement their own timeout or kill sequence.

The supervisor identifies owned processes through the launch ancestry and a per-run environment marker. A repository command that deliberately starts a new session and removes that marker can escape local process discovery. Supporting adversarial self-hosted runners or treating that deliberate double escape as an in-process isolation boundary is out of scope; the supported containment boundary is GitHub-hosted runner teardown. Strengthening that boundary requires a sandbox or container boundary, not another caller-side process scan.
