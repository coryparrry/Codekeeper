# Rivet configuration schema v4

Rivet configuration describes product intent rather than gh-aw implementation
details. The installer writes `.github/rivet.json` with the closed schema v4
surface and rejects unknown fields.

## Review-only default

```json
{
  "schemaVersion": 4,
  "review": {
    "automatic": true,
    "inlineFindings": true,
    "requestChanges": false,
    "maximumFindings": 8
  },
  "repair": { "authority": "never" },
  "issues": { "triage": "automatic", "implementation": "disabled" },
  "maintenance": { "mode": "disabled" },
  "merge": { "authority": "never" },
  "models": {
    "review": {
      "engine": "codex",
      "model": "gpt-5.6-luna",
      "effort": "default"
    }
  }
}
```

The installer converts these controls into a product-authority summary before
rendering. The compiled workflow is then inspected separately and must remain
within that declared authority.

## Engine projection

| Engine  | Model                   | Effort         |
| ------- | ----------------------- | -------------- |
| Codex   | Top-level gh-aw `model` | `default` only |
| Claude  | Top-level gh-aw `model` | `default` only |
| Copilot | Top-level gh-aw `model` | `default` only |
| Gemini  | Top-level gh-aw `model` | `default` only |

The schema recognizes explicit effort values so future migrations can report
them, but the pinned gh-aw v0.86.2 renderer rejects them. Its engine arguments
are also applied to threat detection and can produce an invalid detection
command, so Rivet does not silently approximate this setting.

Rivet does not recreate provider SDKs or expose arbitrary engine configuration.
Advanced upstream features remain native gh-aw imports until Rivet promotes a
stable product-level control.

## Issue boundary

`issues.triage` may be `automatic` or `disabled` for an installation.
Automatic mode has two separate bounded effects: it installs a workflow that
may add at most one App-authored comment to a newly opened issue, and it lets a
pull-request review defer at most one verified, out-of-scope finding to a new
issue. Neither path implements the issue.

Disabled mode installs no issue-triage workflow, disables review deferral, and
requires no GitHub App Issues permission. Enabling automatic triage requires
Issues: write; an existing installation may require explicit GitHub admin
approval for that permission change. `issues.implementation` must remain
`disabled`.

## Remaining boundary

Maintenance report runs are manual or weekly, use the repository-auditor
identity, and emit only a validated JSON artifact plus receipt. They do not
create an issue, pull request, comment, commit, label, or merge and require no
GitHub App permission. Incoming issue triage and pull-request deferral remain
separate capabilities: triage comments on newly opened issues, while deferral
creates an issue for a verified out-of-scope pull-request finding. Neither
authorizes implementation.

Schema v4 can represent a future owner-authorized issue implementation mode;
the current installer rejects it. Repair is a separate explicit authority
upgrade. Merge authority has only one accepted value: `never`.
