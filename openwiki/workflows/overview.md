---
type: workflow-architecture
title: Workflow modes and job contracts
description: Review, maintenance, issue, fix, assistant, and package-bootstrap workflow behavior.
tags: [workflows, github-actions, operations]
---

# Workflow modes and job contracts

The source callers under `.github/workflows/` and packaged assets under `packages/codekeeper/assets/workflows/` are the public automation surface. Each acquires and verifies the exact package, prepares a frozen bundle, runs optional workspace and coordinator jobs, validates/seals results, and publishes only from a later credentialed job. `plan.mjs` rejects a selected capability without its executing workflow; rendered policy carries repository identity, provider/model settings, labels, schedules, and conservative defaults, while the runtime validator remains authoritative.

| Mode | Trigger and mutation boundary |
|---|---|
| Review | Same-repository, non-draft PR targeting default branch, review events/comments, or owner review. Fail-closed gate; labels, feedback, deferred issues, and bounded repair are policy-gated. |
| Maintain | Schedule/manual audit. Report-only by default; one bounded repair when enabled. |
| Issues | Opened/reopened/edited issue or owner triage command. Labels, sticky comment, duplicate/resolved closure, and ready-for-fix are separately gated. |
| Fix | Ready issue, owner implement/fix, or validated repair request. Creates one bounded repair PR or advances an eligible same-PR branch; never silently creates a fallback PR. |
| Assistant | Always-installed lightweight owner-command router. It routes only to installed role workflows and performs no model mutation itself. |

Workflows pin Node/npm/package versions and use run-scoped artifact names and retention. Permissions and secrets are minimal by phase: verification and sealing are credential-free; publication receives the App token. Concurrency, expected-head checks, markers, leases, and live-state rereads make reruns and duplicate events safe. Unsupported forks, drafts, merge queues, Enterprise Server, stale heads, protected branches, and disabled capabilities fail closed.

The complete command path is parsed by `tools/codekeeper/src/lib/commands.mjs`, mapped to installed modes, and authorized by owner association plus configured login. Workflow contract, authorization, package-contract, and acceptance harness tests prove trigger, job, artifact, and mutation behavior. See [runtime execution](../runtime/execution.md) and [runbook](../operations/runbook.md).