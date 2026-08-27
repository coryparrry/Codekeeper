# Rivet configuration schema v4

Rivet configuration describes product intent rather than gh-aw implementation
details. The review-only installer writes `.github/rivet.json` with the closed
schema v4 surface and rejects unknown fields.

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
  "issues": { "triage": "disabled", "implementation": "disabled" },
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

## Review-only boundary

Schema v4 can represent future owner-authorized repair, issue triage, issue
implementation, and maintenance modes. The current installer rejects any such
configuration until the corresponding workflow and authority verification land.
Merge authority has only one accepted value: `never`.
