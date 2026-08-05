# Architecture

AI Repo Maintainer is a source repository of reusable workflows. An adopter keeps the event trigger and policy in its own repository, then calls a reviewed source revision by full commit SHA. There is no shared database, webhook service, or hosted App.

```text
Adopter event and default-branch policy
        |
        v
Pinned reusable workflow revision
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

The reusable workflow checks out its own revision with `job.workflow_repository` and `job.workflow_sha`. It reads the adopter policy only from the adopter default branch. The review caller is a default-branch `pull_request_target` definition that only invokes the reusable workflow; it never checks out or executes PR code. Pull request heads, issue data, comments, repository files, and model output are untrusted.

The workspace specialist and coordinator are separate jobs on fresh runners. A Codex job may receive only its workspace credential and the read-only GitHub access needed to form context; it never receives the provider, trace, or App credential. The coordinator rebuilds its frozen bundle from trusted checkouts and must match that bundle’s context digest to the workspace job output before reading specialist data. It reads only the specialist JSON result and, for write-capable audit/fix modes, a patch artifact as untrusted evidence; it rejects non-regular artifact files and applies that patch only after the model call completes.

The workflow puts its rebuilt frozen context directly in the coordinator prompt. Before the prompt runs, the coordinator loads one versioned Markdown profile from `tools/ai-maintainer/agents/` into `Agent.instructions`: pull request reviewer, issue triager, repository auditor, or maintenance planner. The profile states its output responsibilities and boundaries; the shared instructions retain the no-tool security contract. Profiles add no independent tools or skill packages, while dynamic repository policy and event context remain in the trusted frozen prompt. The coordinator has no independent shell, filesystem, GitHub, credential, or arbitrary network tools. Its SDK runtime separately makes only configured model-provider and trace-export calls. Codex may be configured as one optional workspace specialist per mode, but its untrusted result is evidence only and is never published directly. Candidate artifacts contain the context, result, validation record, and optional patch; a later credential-free job validates repair patches again in a fresh checkout. A final job mints the adopter GitHub App token and publishes only the sealed artifact. It does not execute adopter repository code.

| Coordinator | Loaded profile |
|---|---|
| Pull request reviewer | `tools/ai-maintainer/agents/pr-reviewer.md` |
| Issue triager | `tools/ai-maintainer/agents/issue-triager.md` |
| Repository auditor | `tools/ai-maintainer/agents/repository-auditor.md` |
| Maintenance planner | `tools/ai-maintainer/agents/maintenance-planner.md` |

The selected provider’s `model_api_key` is required for analysis and never falls back to an OpenAI key. Codex may use `workspace_api_key` or its legacy `openai_api_key` compatibility fallback because it requires OpenAI. Tracing uses a distinct required OpenAI `trace_api_key` and cannot reuse any provider key. The starter policy enables tracing with `includeSensitiveData=false`; runs appear at [OpenAI Platform Traces](https://platform.openai.com/traces) in **Logs > Traces**.

Labels and sticky comments are owned only when both their marker and configured App bot identity match. Maintenance fingerprints and repair-PR markers use the same identity check, avoiding a separate state store.

## Review gate and auto-merge

The reusable review workflow exposes a PR-native, fail-closed gate after publication. It passes only after analysis, sealing, and publication succeed for the supported PR shape. It is not an external commit-status publisher.

Auto-merge is separately evaluated from the model recommendation. It requires an allowed author or automation branch, same-repository open non-draft PR, low risk, adequate tests, no blocking findings, complete frozen review-diff context, and the configured file, line, and path limits. A later ineligible review attempts to remove stale auto-merge.

## Supported shape

This design is GitHub.com-only because it depends on reusable-workflow identity fields not available on GitHub Enterprise Server. The review gate supports only non-draft, same-repository PRs aimed at the repository default branch. Forks, drafts, disabled runs, and non-default targets fail closed. The supplied caller does not trigger `merge_group`, so its gate must not be required for merge queues.

Automatic issue triage is restricted to caller-enabled `issues` events for `opened`, `reopened`, and `edited` actions. The workflow records trusted automatic/manual mode in frozen context instead of inferring it from issue text. Automatic publication may add labels, a sticky triage comment, and a duplicate-candidate label; closing an exact duplicate remains separately controlled by default-false `issues.closeExactDuplicates`. Exact owner triage comments and all fixes require an eligible caller association plus a login in `repository.ownerLogins`; manual fixes use the same policy check.
