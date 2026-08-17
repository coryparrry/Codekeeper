# Authority, data, and cost

Codekeeper is designed to make authority explicit. It is still automation that
can send repository information to providers and, when enabled, mutate GitHub.
Review this document before merging an installation.

## Authority

| Capability | Initial recommendation | What to review before enabling |
|---|---|---|
| Automatic PR review | On | Which repository PRs are in the supported surface and whether its gate is required. |
| Manual maintenance | Available | A live run may publish bounded maintenance issues; use `dry_run=true` for report-only output. |
| Scheduled maintenance | Off | Frequency and whether the run is dry or live. |
| Repository repair | Off | Allowed/protected paths, size limits, and deterministic validation commands. |
| Issue implementation | Off | Issue readiness policy, allowed paths, and validation commands. |
| Automatic merge | Off | Branch protection and independent CI requirements. |
| Tracing | Off | Provider access, retention, and the separate trace credential. |

The GitHub App is installed only on the selected repository, but its configured
permissions are still real authority. The installer requests contents write
only when a code-changing capability needs it and shows the exact contents,
issues, and pull-request levels before mutation. Codekeeper's policy cannot
grant a missing permission, and it should not be used as a reason to grant
authority a team would not otherwise accept.

## Data sent to providers

Codekeeper does not run a hosted service, but selected model providers may
receive repository-derived data:

- the coordinator receives frozen event context and bounded specialist
  evidence;
- an enabled Codex workspace specialist can inspect the checked-out repository
  for its assigned task;
- issue titles, bodies, and eligible conversation context are model input for
  triage; and
- review context can include PR metadata, diffs, and workspace evidence.

Provider retention, training, regional processing, and contractual terms are
set by the selected provider and account. Codekeeper does not make those
guarantees on an adopter's behalf. Do not enable it for repositories containing
data that your provider policy does not permit leaving GitHub. A changed path
that needs manual handling should stay manual; do not rely on silent omission
as a privacy control.

Tracing is separately opt-in and needs its own credential. Treat trace access
as operationally sensitive. Do not reuse a model-provider key as a trace key.

## Cost and latency

There is no published, repository-independent cost or latency benchmark yet.
Total cost depends on the selected providers and models, repository size and
change shape, enabled workflows, retries, GitHub Actions usage, and any tracing
or external tooling.

Start with the smallest useful surface:

1. Enable automatic PR review only after a controlled proof PR.
2. Keep maintenance manual and start with `dry_run=true`; a live audit may publish maintenance issues.
3. Keep scheduled maintenance, repair, issue implementation, and automatic
   merge off until the team has reviewed real outcomes.
4. Choose lower-cost coordinator and workspace models where their observed
   quality is sufficient.
5. Inspect provider billing and GitHub Actions usage in the accounts that pay
   for them.

The installer exposes model choices and workflow controls, but it does not turn
an estimated spend into a guaranteed ceiling. Set organisational billing limits
outside Codekeeper until per-run budget controls and public measurements are
available.

Current local-package evaluation also cannot establish a real workflow cost or
latency result while the generated runtime package is unavailable from npm.

## Before enabling a mutation

Require a small pull request, reviewed policy, deterministic validation beyond
`git diff --check`, and normal branch protection. A successful setup pull
request or dry run is not a substitute for an App-authored publication on a
controlled same-repository PR.
