# Runtime v2 invariants

This document records the baseline contract for the first Runtime v2 change.
PR 1 adds measurement and contract coverage only. It does not change a
production workflow, caller, package asset, runtime implementation, generated
manifest, or release hash.

## Current graph

The production reusable workflows currently have these job graphs:

```text
review:   analyze -> gate
issue:    workspace -> analyze -> seal -> publish
fix:      workspace -> analyze -> verify -> seal -> publish
maintain: workspace -> analyze -> verify -> seal -> publish
```

The review workflow combines specialist and coordinator analysis on one fresh
runner. Its gate always evaluates when routing did not explicitly return false.
Issue, fix, and maintenance workflows retain isolated workspace, coordinator,
verification, sealing, and publication jobs. Each handoff uses a run-scoped
artifact and the receiving job independently verifies the package before
installing the runtime.

## Security rules

These are the twelve non-negotiable rules that Runtime v2 must preserve while
its stages are refactored:

1. **App private key exclusion.** The App private key is never referenced by
   compute or validation.
2. **Provider and trace exclusion.** Provider and trace keys are never
   referenced by validation or publication.
3. **Workspace-only specialist credential.** The workspace specialist receives
   only the workspace credential.
4. **Post-workspace coordinator credentials.** The coordinator receives
   provider and trace credentials only after workspace identity and processes
   have been removed.
5. **Fresh credential-free validation.** Repository validation runs only on a
   fresh credential-free runner.
6. **Code-free publication.** Publication never runs validation, lifecycle
   hooks, or arbitrary candidate code.
7. **Seal before App token.** Sealing completes before an App token is created.
8. **Independent runner verification.** Every runner independently verifies
   the exact package version, integrity, source identity, and relevant handoff
   before consuming it.
9. **Failed-review gate.** Failed review compute still fails the required gate.
10. **No writable cross-run cache.** There is no writable dependency cache shared
    across runs.
11. **No inherited secrets.** Callers use explicit named secrets; the
    `secrets: inherit` form is forbidden.
12. **Pinned old installations.** Existing package and workflows remain pinned
    until the generated update PR merges.

The workflow-topology contract test reads the production workflow paths and
checks these placement and ordering rules. A fixture records the expected job
names so a new, removed, or reordered job is visible as a deliberate baseline
change rather than silently changing the contract.

## Staged state-machine direction

Runtime v2 should model the workflow as a monotonic envelope state machine with
explicit artifacts between states:

```text
created -> compute-complete -> (validation-complete | validation-not-required) -> sealed -> published
```

The current jobs map toward this envelope as workspace/coordinator work
produces `compute-complete`, repair-capable modes produce
`validation-complete`, and review/issue paths use `validation-not-required`
where no repository validation is part of the mode. A state transition must
consume a frozen input, produce a digest-bound output, and fail closed when the
output is missing, stale, malformed, or inconsistent with its predecessor.
Publication is the only state allowed to mint an App token or perform GitHub
mutation. Retries may repeat a state with the same run-scoped identity, but may
not skip a predecessor or reinterpret an artifact from another run.

## Measurement contract

`scripts/measure-codekeeper-runs.mjs` is a read-only GitHub CLI/API collector.
It accepts explicit run IDs or an inclusive repository/run-ID range and emits
deterministic JSON. For each run it reports:

- workflow creation, start, and update timestamps;
- every job's start/completion timestamps, approximate queue delay, and
  duration;
- runner allocations (one per job with a non-null `started_at`, unless its
  conclusion is `skipped`);
- checkout, setup-node, package-acquisition, runtime-installation, and separate
  artifact upload and download step counts (plus their combined total); and
- model-call step durations when the Actions API includes usable step timing
  metadata.

The queue estimate is `job.started_at - workflow.created_at`; it is an upper
bound that includes workflow dispatch and runner scheduling, not a direct
GitHub queue metric. Total elapsed time is `run.updated_at - run.created_at`.
Job duration is `completed_at - started_at`. Missing timestamps for a still
queued or in-progress job are represented as `null` for the derived value;
malformed objects, missing required arrays, invalid timestamps, impossible
negative intervals, and incomplete API responses cause the collector to fail
closed rather than emit a partial measurement.

Counts are inferred from the step names and timestamps returned by the Actions
jobs REST response. Live job step objects expose names and timing fields rather
than a stable action identity field, so action identity is inferred from the
name text; these counts describe observed workflow steps, not billed minutes or
physical machines. A job counts as one runner allocation only when its
`started_at` is non-null and its conclusion is not `skipped`; this excludes
skipped or never-started jobs but cannot observe infrastructure that GitHub
never exposes. Model-stage timing is limited
to steps whose names identify an Agents SDK, Codex, coordinator, or model call
and only when both step timestamps are present. GitHub API latency, queue internals,
cache behavior, token minting latency, and provider-side model time are not
recoverable from this collector unless the run metadata exposes them.

The script never embeds credentials, prints API responses, or claims a live
performance target. Measurements are evidence for later comparisons; they are
not a release or security proof by themselves.
