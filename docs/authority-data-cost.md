# Authority, data, and cost

Rivet sends repository-derived context to the configured model provider and can
publish through a repository-scoped GitHub App. Review those boundaries before
installing it.

## Authority

| Capability            | Default   | Authority                                                                                                                                                                                                                      |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pull-request review   | Automatic | App-authored review comments and four managed labels: `changes required`, `review needed`, `merge ready`, and `needs tests`. Other labels are preserved. A deferred finding may create one issue when issue triage is enabled. |
| Incoming issue triage | Automatic | One bound App-authored comment per eligible issue opening or follow-up.                                                                                                                                                        |
| Repair                | Optional  | An owner-authorized command may publish one validated repair commit to the same pull-request branch.                                                                                                                           |
| Maintenance           | Disabled  | Manual or weekly report-only audit artifact; no App token or GitHub mutation.                                                                                                                                                  |
| Issue implementation  | Disabled  | Unsupported.                                                                                                                                                                                                                   |
| Automatic merge       | Disabled  | Unsupported.                                                                                                                                                                                                                   |

Bare `rivet init` is the guided review-only path. It checks a clean checkout at
the exact default-branch head, shows the requested App permissions, creates and
verifies a repository-selected GitHub App, stores the App key and model key as
encrypted GitHub Actions secrets, and creates a verified draft setup pull
request. The user reviews, marks ready, and merges that pull request to activate
Rivet.

Rivet cannot grant a missing permission. Expanding an existing installation may
require a repository administrator to approve the changed App authority.
Repair is a separate explicit installation mode and widens the App's Contents
permission from read to write.

## Data sent to providers

Review may include pull-request metadata, diffs, bounded exact-head source, and
prior Rivet reviews and inline comments. Issue triage may include the issue
title, body, labels, Rivet's previous triage state, and bounded follow-up
comments. Maintenance inspects the exact default-branch snapshot and produces a
report artifact. Repair uses the reviewed finding and the checked-out
pull-request branch.

Provider retention, training, regional processing, and contractual terms are
controlled by the selected provider account. Do not enable Rivet where those
terms do not permit the repository data to leave GitHub.

## Cost and latency

Rivet has no repository-independent cost or latency guarantee. Usage depends on
the selected model, repository and change size, enabled workflows, retries, and
GitHub Actions usage. Start with a controlled adopter repository, inspect the
provider and Actions billing records, and enable scheduled maintenance only when
the report is useful enough to justify the recurring run.

A local evaluator or installer dry-run proves only its local boundary. Live
publication requires a controlled GitHub run bound to the exact installed
workflow and commit.
