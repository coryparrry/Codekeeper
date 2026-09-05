# Architecture

Rivet is a versioned npm package that installs repository-local GitHub Agentic
Workflows. The package owns configuration validation, workflow rendering, the
pinned `gh-aw` compiler receipt, compiled-workflow inspection, managed assets,
upgrade compatibility, and offline evaluators. The adopter repository owns the
installed policy, workflows, GitHub App, and credentials. Rivet has no hosted
service or shared state store.

```text
.github/rivet.json
        |
        v
Rivet renders managed Markdown, profiles, and local actions
        |
        v
checksum-verified gh-aw v0.86.2 compiles .lock.yml workflows
        |
        v
Rivet inspects the compiled authority and prepares a guarded install plan
        |
        v
verified draft setup PR or explicit direct write
```

## Installation and upgrade boundary

The closed schema v4 configuration in `.github/rivet.json` is the product
authority source. The installer renders all enabled workflows into a temporary
directory, compiles them, and checks the resulting authority before it plans a
repository write. The installation receipt binds the managed file inventory,
mode, and configuration.

Bare `rivet init` resolves the Git repository root even when invoked from a
nested directory. Explicit modes use the current directory unless
`--repository` supplies the root. Both paths read the configuration from that
selected root. Issue and maintenance flags change only their requested fields,
and `--repair` changes only repair authority; existing model choices, review
limits, and other configuration remain intact.

Rivet overwrites an existing managed file only when it matches the current
output, a frozen supported historical baseline, or a recognized prior managed
digest. Compiled workflow locks are compared as parsed YAML so compiler-only
comments or formatting do not cause churn. When a lock is semantically
equivalent, Rivet keeps its existing bytes and does not build the historical
upgrade matrix solely for that drift. Any other edited managed file fails
closed instead of being overwritten. Review-to-repair upgrades use the same
validated configuration and accept only the corresponding frozen review
baseline.

## Pull-request review flow

```text
pull_request_target event
        |
        v
trusted base-branch actions freeze the exact comparison and bounded context
        |
        v
eligible run reconciles Rivet labels to `review needed`
        |
        +-- snapshot unavailable -> keep `review needed`; no model publication
        |
        v
agent reviews the inlined prompt without a repository checkout or GitHub reads
        |
        v
gh-aw Safe Outputs publishes the bound review, comments, and optional issue
        |
        v
Rivet verifies successful publication and reconciles the final managed labels
```

The installed review lock runs only for `pull_request_target` events and uses
per-pull-request concurrency with cancellation. Trusted base-branch actions
fetch one event-bound comparison, bounded exact-head source blobs, and bounded
prior Rivet review context. Pull-request text, changed code, repository context,
prior comments, and model output remain untrusted evidence.

After context preparation, an eligible event gets `review needed`; stale
`changes required`, `merge ready`, and `needs tests` labels are removed. This
pending state is authorized even when context preparation did not produce a
review snapshot, so a failed or incomplete analysis cannot leave an old
success label visible.

The agent receives the reviewer profile and native extension already inlined in
the compiled workflow. It has no repository checkout, GitHub MCP access, or
model shell access for Codex. A complete comparison must publish one general
review and one structured `publish_review_tags` output. After Safe Outputs
succeeds, Rivet checks that the review body contains exactly one status matching
the structured recommendation, then selects `changes required`,
`review needed`, or `merge ready`. It adds `needs tests` only when the same
successful output reports a concrete missing deterministic test.

The pending and final label jobs mutate only those four Rivet-managed names;
all unrelated labels remain untouched. Each job checks the pull request ID,
number, open state, base SHA, and head SHA before mutations and checks the final
managed set afterward. GitHub has no label compare-and-swap operation, so the
workflow also relies on per-PR concurrency and the next event's pending reset to
bound the final request-sized race.

## Compiled workflow trust

Rivet accepts native imports only from managed `.github/rivet/agents/` and
`.github/rivet/aw/` Markdown paths. The compiled review workflow must retain
strict mode, the `pull_request_target` manifest, inlined imports, immutable
action and container pins, approved local actions, exact model selection,
bounded Safe Outputs, base-context checkouts without persisted credentials, and
the approved job, permission, environment, condition, and script inventory.

The compiled authority digest normalizes only declared product choices. For
example, `review.maximumFindings` may be any configured integer from 1 to 20;
Rivet accepts a compiled custom limit only when it equals the requested value
and the rest of the compiled authority still matches the approved inventory.
This keeps supported configuration flexible without allowing unrelated
compiler drift to widen workflow authority.

The review GitHub App token is scoped to the target repository. The model's
provider credential is separate from App publication authority. Issue triage
adds Issues write only when enabled. Repair is a distinct installation mode
that widens Contents to write and keeps credential-free validation separate
from publication of the immutable validated artifact. Maintenance is manual or
scheduled report-only execution with empty root permissions and no generic
Safe Output publisher.

## Evidence boundary

Package tests prove rendering, compilation, authority inspection, upgrade
compatibility, and evaluator behavior against local fixtures. They do not prove
provider availability, GitHub App installation, workflow execution, or live
publication. Those require a controlled adopter run bound to the installed
package, exact pull-request head, workflow URL, App identity, job conclusions,
and resulting GitHub objects.
