# Whole-Repository Adversarial Hardening Report

**Checkout:** `8f36d51` (`chore(release): repin rebased command centre`)
**Date:** 2026-08-11
**Scope:** `packages/codekeeper`, `tools/codekeeper`, `acceptance`, reusable workflows, release/tooling contracts, and existing tests.

## Executive result

The repository’s normal offline suites are green, but the adversarial suite exposes release-relevant failures in timeout handling, mutation authorization, stale-state revalidation, secret input, pagination, and resource bounds. No production code was changed and no fix was attempted.

The audit added 23 intentionally red tests:

- `tools/codekeeper/audit/*.test.mjs`: **16/16 fail** against the current head;
- `packages/codekeeper/audit/*.test.mjs`: **4/4 fail**;
- `acceptance/audit/*.test.mjs`: **3/3 fail**.

The existing baselines remain green: runtime **198/198**, installer/TUI **166/166**, acceptance **24/24** plus **2/2** fixture tests. The root check cannot run because `eslint` is not installed in the checkout.

## High-priority findings

### P1 — provider and validation work can hang until the workflow timeout

`tools/codekeeper/src/lib/git.mjs:16-30,208-239` uses synchronous validation execution without a timeout. A `sleep 2` validation command exceeds the audit deadline and leaves the child alive.

`tools/codekeeper/src/lib/agents-runtime.mjs:520` awaits `Runner.run` without a wall-clock deadline or abort boundary. A fake provider promise that never settles also exceeds the audit deadline. This can hold review, issue, audit, or fix jobs until their outer 20–45 minute workflow timeout.

Proof: `runtime-hardening.test.mjs` (`a hung validation command...`, `a hung model-provider turn...`). The provider test deliberately keeps an active event-loop handle, so an unsettled promise cannot make the child exit spuriously.

### P1 — automatic repair authorization and retry state are unsafe

`tools/codekeeper/src/lib/publish.mjs:453-463` writes `codekeeper:auto-repaired` before dispatch. If dispatch fails, the marker remains; the next review sees the marker and suppresses retry. The automatic repair path becomes permanently stranded after a transient dispatch failure.

The dispatch payload at `publish.mjs:458` omits policy authorization metadata. `.github/workflows/codekeeper-fix.yml:146` then defaults the event to owner authorization. Current configuration rejects the automation actor in owner mode; if the actor were made an owner, the path could bypass policy-mode marker checks.

`tools/codekeeper/src/lib/pr-repair.mjs:124-140` revalidates the pull request before commit and push but does not revalidate `codekeeper:auto-repaired`. Removing that marker after preparation therefore does not revoke a policy-authorized repair.

Proof: `publish-hardening.test.mjs` and `workflow-boundary-hardening.test.mjs`. The marker requirement must remain conditional for explicit owner-requested repairs.

### P1 — secrets can be truncated or left pending indefinitely in the installer

`packages/codekeeper/src/tui.mjs:333-379` accepts ordinary keystrokes through the same path as a paste and calls `spec.write` immediately. The first character of a credential is written before the user completes the value.

After cancellation, `FilePickerScreen` can still call the shared `settle` callback from a delayed `picker.activate` promise. A delayed old selection resolves a newly presented picker with the old `.pem` path.

`packages/codekeeper/src/install.mjs:217-253` passes `timeoutMs: null` to secret upload commands. The command runner intentionally treats that as no timer, so a post-input `gh secret set` hang is unbounded.

Proof: `tui-hardening.test.mjs` and `install-hardening.test.mjs`.

### P1 — acceptance freshness gates can accept stale or concurrent work

`acceptance/src/harness.mjs:1055,1076` verifies manually supplied review/issue run IDs without passing a dispatch freshness boundary. A prior run that matches the current title, workflow, source, and marker shape can satisfy the current assertions.

`assertQuiescent` at `acceptance/src/harness.mjs:716` checks only the returned first page. The workflow-run query is capped at 100, so an active matching run outside that page is invisible to the quiescence gate.

The same baseline design revalidates each prior run on every discovery and completion poll. With 100 baseline runs and the documented poll limits, the worst path is approximately 14,200 individual metadata requests, creating avoidable latency and rate-limit pressure.

Proof: `acceptance-boundary-hardening.test.mjs`; the request-amplification result is source-derived and independently confirmed by the acceptance review.

### P1 — audit publication can use an obsolete default-branch tip

`tools/codekeeper/src/lib/publish.mjs:893-946` compares the local checkout `HEAD` to the frozen base SHA, then mutates GitHub. It does not re-read the remote default-branch ref immediately before publication. A branch advance after checkout can therefore leave the audit finding or repair based on an obsolete default branch.

Proof: the source-contract assertion in `acceptance-boundary-hardening.test.mjs`; the GitHub client already has remote ref access, but this boundary does not use it.

## Other confirmed defects

| Severity | Area | Evidence and impact | Proof |
|---|---|---|---|
| P1, conditional | GitHub pagination | `github.mjs:122-248` follows arbitrary `Link` URLs and attaches the bearer token to the next request. Cyclic empty-page links also have no visited-URL or finite-page bound. | `pagination-hardening.test.mjs` |
| P1, enabled path | Duplicate closure | `publish.mjs:592-609` updates the issue with Codekeeper’s marker comment, then compares the old `updated_at` before duplicate comment/close. Enabled `closeExactDuplicates` fails with “changed after analysis”. | `publish-hardening.test.mjs` |
| P1, conditional | Owner command failure | `commands.mjs:220-246` removes `codekeeper:paused` before dispatch. A dispatch failure leaves the target unpaused. | `commands-hardening.test.mjs` |
| P2 | Live review state | `publish.mjs:258-348` does not revalidate draft or paused state at the publication boundary. | `workflow-boundary-hardening.test.mjs` |
| P2 | Target resolution | `.github/workflows/codekeeper-fix.yml:292-296` omits `github.event.client_payload.number` in `analyze`, unlike `workspace`. Repository-dispatch events can spend workspace work and then fail target resolution. | `workflow-boundary-hardening.test.mjs` |
| P2 | CLI safety | `io.mjs:49-90` accepts unknown flags. A misspelled dry-run option is silently ignored while CLI defaults `dryRun` to false. | `runtime-hardening.test.mjs` |
| P2, conditional | Credential environment | `git.mjs:208-226` removes a finite denylist but leaves `CODEKEEPER_MODEL_API_KEY` and `CODEKEEPER_TRACE_API_KEY` in validation-command environments. Default verification jobs currently do not carry those credentials; risk increases if that topology changes. | `runtime-hardening.test.mjs` |
| P2 | Workflow log integrity | `io.mjs:30-36` and `cli.mjs:269-272` can emit a newline-bearing path inside a GitHub `::error::` annotation, allowing a second workflow command line. This is protocol/log injection, not shell execution. | `runtime-hardening.test.mjs` |
| P2 | Picker resource bound | `private-key-input.mjs:23-84` materializes all directory entries and sequentially probes every child directory. A 500-child delayed listing exceeds the audit deadline. | `picker-hardening.test.mjs` |
| P2, conditional | Workspace capture | `git.mjs:150-195` reads untracked content and the complete diff before `validate.mjs:225-257` applies the 256 KiB file / 512 KiB patch policy. The probe materializes 655,591 bytes before rejection. | `git-boundary-hardening.test.mjs` |

## Complexity and slop review

The complexity scanner, code-review pass, Thermos pass, and simplification pass agree on structural risk without treating every heuristic warning as a bug:

- `tools/codekeeper/src/lib/publish.mjs` is 1,016 lines;
- `acceptance/src/harness.mjs` is 1,301 lines;
- acceptance baseline validation is O(B × P), where B is baseline runs and P is polls;
- maintenance matching contains repeated finding/issue scans; review reply publication contains N+1 API calls; pagination and picker traversal lack finite resource budgets;
- contracts are distributed across workflow YAML, CLI parsing, GitHub adapters, publication code, and preparation code, which made producer/consumer drift possible.

These are maintainability and release-risk observations, not production changes. No refactor, simplification, timeout, or policy change was applied during this audit.

## Conditional findings and limitations

- The pagination bearer-token path requires a compromised, proxied, or otherwise nonstandard upstream response; ordinary GitHub.com repository actors do not control GitHub’s response headers.
- The provider/validation 750ms thresholds are audit deadlines, not claimed production budgets. The defect is the absence of an internal finite boundary, not the exact threshold.
- The automatic repair and duplicate-closure paths are default-off in the checked-in policy, but their enabled behavior is still release-relevant.
- The manually supplied acceptance run issue is a contract gap if `--run-id` is intended to identify the current dispatch; if it is intentionally an operator-trusted recovery mode, the documentation and test contract need to say so explicitly.
- No live GitHub or App Store mutation was performed. No destructive command, commit, push, or production fix was performed.

## Evidence index

- Runtime: [`tools/codekeeper/audit/runtime-hardening.test.mjs`](../../tools/codekeeper/audit/runtime-hardening.test.mjs)
- Pagination: [`tools/codekeeper/audit/pagination-hardening.test.mjs`](../../tools/codekeeper/audit/pagination-hardening.test.mjs)
- Publication: [`tools/codekeeper/audit/publish-hardening.test.mjs`](../../tools/codekeeper/audit/publish-hardening.test.mjs)
- Commands/workflows: [`tools/codekeeper/audit/commands-hardening.test.mjs`](../../tools/codekeeper/audit/commands-hardening.test.mjs), [`tools/codekeeper/audit/workflow-boundary-hardening.test.mjs`](../../tools/codekeeper/audit/workflow-boundary-hardening.test.mjs)
- Workspace resource boundary: [`tools/codekeeper/audit/git-boundary-hardening.test.mjs`](../../tools/codekeeper/audit/git-boundary-hardening.test.mjs)
- Installer/UI: [`packages/codekeeper/audit/install-hardening.test.mjs`](../../packages/codekeeper/audit/install-hardening.test.mjs), [`packages/codekeeper/audit/picker-hardening.test.mjs`](../../packages/codekeeper/audit/picker-hardening.test.mjs), [`packages/codekeeper/audit/tui-hardening.test.mjs`](../../packages/codekeeper/audit/tui-hardening.test.mjs)
- Acceptance: [`acceptance/audit/acceptance-boundary-hardening.test.mjs`](../../acceptance/audit/acceptance-boundary-hardening.test.mjs)
- Live progress: [`2026-08-11-whole-repo-hardening-progress.md`](2026-08-11-whole-repo-hardening-progress.md)
