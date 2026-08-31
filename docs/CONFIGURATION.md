# Configuration

Rivet writes adopter-owned policy to `.github/rivet.json`. Schema v4 is closed:
unknown or missing fields fail validation. Start with the guided installer:

```bash
npx @coryparry/rivet init
```

The default policy enables automatic pull-request review and incoming issue
triage. Repair, issue implementation, maintenance, and merge remain disabled.

## Issue controls

`issues.triage` currently supports two installable modes:

- `automatic` installs the incoming issue-triage workflow for newly opened
  issues. It may publish at most one App-authored comment. It cannot label,
  close, implement, open a pull request, or merge.
- `disabled` installs no issue-triage workflow. Pull-request review cannot
  defer a finding to a new issue, and the GitHub App needs no Issues
  permission.

Automatic triage also lets a pull-request review defer at most one verified,
out-of-scope finding to a new issue. Deferral creates the issue; incoming
triage comments on a newly opened issue. They are separate actions governed by
the same permission, and neither authorizes implementation.

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
| `maintenance.mode`       | Must remain `disabled`.                                                     |
| `merge.authority`        | Must remain `never`.                                                        |

The `models.review` engine, model, and effort are also used for incoming issue
triage. The current default is Codex with `gpt-5.6-luna` and `default` effort.
See [schema v4](RIVET_SCHEMA_V4.md) for the complete JSON shape and
[GitHub App authority](RIVET_GITHUB_APP_AUTHORITY.md) for permissions.
