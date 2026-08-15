# Architecture

Codekeeper is a source repository of reusable workflows. An adopter keeps the event trigger and policy in its own repository, then calls a reviewed source revision by full commit SHA. There is no shared database, webhook service, or hosted App.

```text
Adopter event and default-branch policy
        |
        v
Pinned bootstrap action and reusable workflow revision (same full SHA)
        |
        +-- direct private action stages only tools/codekeeper as a one-day artifact
        |     - no caller-provided source credential or source checkout
        |     - every reusable job verifies pinned manifest, inventory, hashes, no symlinks or hidden paths
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

The caller pins a direct Codekeeper action and reusable workflow to the same full commit SHA. GitHub's private-action access retrieves that action without a caller-provided PAT or source-repository App installation. The direct action stages only the production `tools/codekeeper` payload as a one-day artifact. Hidden paths are refused to match GitHub artifact uploads' secure default. That artifact is untrusted until every reusable job verifies the source-pinned manifest's raw SHA-256, the verifier's manifest hash, an exact inventory, every file hash, and the absence of symlinks or hidden paths; only then may `npm` or the Codekeeper CLI run. The reusable workflow uses `job.workflow_sha` for provenance and reads adopter policy only from the adopter default branch. The review caller is a default-branch `pull_request_target` definition that only invokes the reusable workflow; it never checks out or executes PR code. Pull request heads, issue data, comments, repository files, and model output are untrusted.

The workspace specialist and coordinator are separate jobs on fresh runners. The workspace job launches the pinned Codex CLI as a local stdio MCP server through the Agents SDK; there is no separately hosted MCP service or Codex GitHub Action. The MCP host receives only its workspace credential and passes a minimal environment to Codex, while Codex's shell policy excludes secret variables from spawned commands. It never receives the provider, trace, or App credential. The coordinator rebuilds its frozen bundle from trusted checkouts and must match that bundle’s context digest to the workspace job output before reading specialist data. It reads only the specialist JSON result and, for write-capable audit/fix modes, a patch artifact as untrusted evidence; it rejects non-regular artifact files and applies that patch only after the model call completes.

The workspace specialist receives the full frozen task prompt and produces bounded evidence. A review normally makes one workspace call. If that Medium result contains a current, high-confidence, blocking `high` or `critical` finding at a concrete line in the frozen changed-file list, the same MCP session makes one focused Max call in the same checkout. Overall risk, proposed labels, general security language, non-blocking findings, and unlocated findings cannot trigger that call. The Max result replaces the Medium result rather than being merged with it. Reviews pre-routed to Max from trusted labels, configured paths, or change-size thresholds make only their original Max call.

When a specialist finishes, the coordinator receives a separate compact prompt containing only target metadata, policy constraints, and the final specialist evidence; every emitted claim must be copied from that result. It may omit optional evidence or choose a strictly more conservative enum state, but cannot add or rewrite findings, commands, tests, implementation claims, maintainer decisions, comments, summaries, repair metadata, or explanatory reasons. A specialist-required maintainer decision must remain required, so it cannot be bypassed by an `ai-ready` result. Issue triage uses the full bounded issue context only when its specialist is disabled. Workspace-disabled review, audit, and fix modes return deterministic fail-safe results without a provider call. Coordinators run for one turn and omit textual schemas when the provider enforces structured output. Before the prompt runs, the coordinator loads one versioned Markdown profile from `tools/codekeeper/agents/` into `Agent.instructions`: pull request reviewer, issue triager, repository auditor, or fixer. The profile states its output responsibilities and boundaries; the shared instructions retain the no-tool security contract. The coordinator has no independent shell, filesystem, GitHub, credential, or arbitrary network tools. Candidate artifacts hash and retain the context, result, per-pass workspace timings, runtime usage and cache metadata, validation record, and optional patch; a later credential-free job validates repair patches again in a fresh checkout. A final job mints the adopter GitHub App token and publishes only the sealed artifact. It does not execute adopter repository code.

Every Codex workspace uses a fresh runner-owned `CODEX_HOME` with `project_doc_max_bytes=0`, fallback project documents disabled, and automatic skill instructions disabled. Because pinned Codex independently discovers repository skills, `.agents/skills` and `.codex/skills` are moved into a runner-owned quarantine for the model invocation and restored before patch capture. Any replacement instruction surface created during the run fails the job.

| Coordinator | Loaded profile |
|---|---|
| Pull request reviewer | `tools/codekeeper/agents/pr-reviewer.md` |
| Issue triager | `tools/codekeeper/agents/issue-triager.md` |
| Repository auditor | `tools/codekeeper/agents/repository-auditor.md` |
| Fixer | `tools/codekeeper/agents/fixer.md` |

The selected provider’s `model_api_key` is required for analysis and never falls back to an OpenAI key. Codex may use `workspace_api_key` or its legacy `openai_api_key` compatibility fallback because it requires OpenAI. OpenAI is the default trace exporter and uses a distinct `trace_api_key`. The review caller can choose Braintrust instead; that key and pinned adapter exist only in the fresh coordinator job, never the Codex workspace or publication job. Neither exporter may reuse a model-provider key. The starter policy keeps sensitive trace data off by default.

Labels and sticky comments are owned only when both their marker and configured App bot identity match. Maintenance fingerprints and repair-PR markers use the same identity check, avoiding a separate state store.

## Policy validation seam

The production runtime owns the complete version 3 policy contract in `tools/codekeeper/src/lib/policy-validator.mjs`. Both file loading and the guided installer call its loader-independent `validatePolicy` boundary, so accepted object keys, relationships, bounds, schedules, labels, providers, agents, and safety constraints cannot drift between setup and execution. The unified npm release stage contains the canonical runtime and a generated byte-identical installer copy; repository checks fail if that copy differs. Existing source-pinned Actions remain a compatibility execution channel until generated workflows migrate to the packaged runtime.

Installer validation adds only installation-context constraints: immutable safety fields cannot be edited, enabled capabilities must have their executing workflows, model providers must have an installer credential mapping, and agent profiles must be bounded Markdown. These checks do not redefine the runtime policy schema.

## Conditional GitHub mutation seam

Review publication opens one conditional pull mutation in the GitHub adapter. The adapter captures the live label set and binds it to the sealed repository, head SHA, base SHA/ref, and policy-filtered feedback hash. Every REST write and GraphQL mutation then re-reads and compares that state inside the transport seam before sending the write. Successful Codekeeper label mutations advance only the adapter's expected label state; a rollback can remove only a label that the same conditional mutation added.

GitHub does not provide a transaction or compare-and-swap precondition spanning pull metadata, reviews, comments, labels, and repository dispatch. A remote change can therefore still land after the adapter's final comparison and before GitHub accepts the immediately following write. That final request-sized race is an explicit platform limitation, not a defect to address with additional caller-side reads. Codekeeper fails closed for every drift it observes at the mutation seam, and postconditions remain responsible only for proving the result of a mutation such as auto-merge activation.

## Review gate and auto-merge

The reusable review workflow exposes a PR-native, fail-closed gate in the same trusted post-seal job as publication, avoiding a serial runner allocation without combining the workspace, coordinator, seal, or App-token trust boundaries. The gate step always runs and passes only after analysis, sealing, and publication succeed for the supported PR shape. It is not an external commit-status publisher.

Auto-merge is separately evaluated from the model recommendation. It requires an allowed author or automation branch, same-repository open non-draft PR, low risk, adequate tests, no blocking findings, complete frozen review-diff context, and the configured file, line, and path limits. A later ineligible review attempts to remove stale auto-merge.

## Supported shape

This design is GitHub.com-only because it depends on reusable-workflow identity fields not available on GitHub Enterprise Server. The review gate supports only non-draft, same-repository PRs aimed at the repository default branch. Forks, drafts, disabled runs, and non-default targets fail closed. The supplied caller does not trigger `merge_group`, so its gate must not be required for merge queues.

Automatic issue triage is restricted to caller-enabled `issues` events for `opened`, `reopened`, and `edited` actions. The workflow records trusted automatic/manual mode in frozen context instead of inferring it from issue text. Automatic publication may add labels, a sticky triage comment, and a duplicate label. With `issues.closeResolvedIssues=true`, it closes an issue as completed only when GitHub authoritatively links a merged closing pull request, then revalidates that frozen reference before mutation. Closing an exact duplicate remains separately controlled by default-false `issues.closeExactDuplicates`. Exact owner triage comments and all fixes require an eligible caller association plus a login in `repository.ownerLogins`; manual fixes use the same policy check.

## Validation process boundary

Repair validation runs only on the supplied ephemeral GitHub-hosted Ubuntu runner. One process supervisor owns the command deadline, bounded output tails, launch process group, observable descendants, and `SIGTERM`-then-`SIGKILL` escalation; validation callers do not implement their own timeout or kill sequence.

The supervisor identifies owned processes through the launch ancestry and a per-run environment marker. A repository command that deliberately starts a new session and removes that marker can escape local process discovery. Supporting adversarial self-hosted runners or treating that deliberate double escape as an in-process isolation boundary is out of scope; the supported containment boundary is GitHub-hosted runner teardown. Strengthening that boundary requires a sandbox or container boundary, not another caller-side process scan.
