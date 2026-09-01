# Configuration

Rivet writes adopter-owned policy to `.github/rivet.json`. Schema v4 is closed:
unknown or missing fields fail validation. Start with the guided installer:

```bash
npx @coryparry/rivet init
```

The default policy enables automatic pull-request review and incoming issue
triage. Maintenance, repair, issue implementation, and merge remain disabled by
default.

## Maintenance reports

Enable a report manually or weekly when installing:

```bash
npx @coryparry/rivet init --review-only --maintenance scheduled --setup-pr
```

Use `manual` instead of `scheduled` to omit the weekly trigger. The
`repository-auditor` identity runs against the exact frozen default-branch
snapshot and emits a validated JSON artifact plus receipt. It is report-only:
it cannot create an issue, pull request, comment, commit, label, or merge, and
it needs no GitHub App permission. It uses the configured `models.review`
engine and model (Codex `gpt-5.6-luna` by default). An incomplete report is
retained as incomplete; it is never treated as a clean audit.
Use `--maintenance disabled` to remove an existing Rivet-owned maintenance
workflow through the same verified installation path.

## Issue controls

`issues.triage` currently supports two installable modes:

- `automatic` installs incoming issue triage for newly opened issues and
  authorized follow-up replies. Rivet records its unresolved questions in its
  App-authored comment, then supplies that bounded state and the subsequent
  conversation when it reassesses the issue. It cannot label, close,
  implement, open a pull request, or merge.
- `disabled` installs no issue-triage workflow. Pull-request review cannot
  defer a finding to a new issue, and the GitHub App needs no Issues
  permission.

Automatic triage also lets a pull-request review defer at most one verified,
out-of-scope finding to a new issue. Deferral creates the issue; incoming
triage comments on a newly opened issue. They are separate actions governed by
the same permission, and neither authorizes implementation.

Pull-request review context includes a bounded set of exact-head source blobs
and prior Rivet reviews and inline comments. Historical content is treated as
untrusted memory: the current comparison and verified blob identity remain the
authority for findings, duplicate suppression, and deferral.

Enabling automatic triage requires GitHub App Issues: write. Existing App
installations may require explicit approval from a GitHub administrator before
the new permission takes effect. `issues.implementation` must remain
`disabled`; Rivet does not install an issue implementation workflow.

## Other controls

| Setting                  | Current behavior                                                            |
| ------------------------ | --------------------------------------------------------------------------- |
| `review.automatic`       | Runs review on eligible pull-request events.                                |
| `review.inlineFindings`  | Allows bounded inline review comments.                                      |
| `review.requestChanges`  | Chooses comment-only or request-changes review.                             |
| `review.maximumFindings` | Limits findings to an integer from 1 to 20.                                 |
| `repair.authority`       | `never` by default; `owner` requires the separate repair authority upgrade. |
| `maintenance.mode`       | `disabled`, `manual`, or weekly `scheduled`; report-only in enabled modes.  |
| `merge.authority`        | Must remain `never`.                                                        |

The `models.review` engine, model, and effort are also used for incoming issue
triage. The current default is Codex with `gpt-5.6-luna` and `default` effort.
See [schema v4](RIVET_SCHEMA_V4.md) for the complete JSON shape and
[GitHub App authority](RIVET_GITHUB_APP_AUTHORITY.md) for permissions.
