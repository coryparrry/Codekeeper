# Configuration

The adopter-owned `.github/codekeeper.json` is the runtime policy file. Four separate adopter-owned Markdown profiles under `.github/codekeeper/agents/` tune coordinator judgment. The workflow reads both policy and the selected profile from the adopter default branch, freezes them into the run, and hash-checks them again before publication.

## Validation and resource bounds

Version 2 treats every named policy object as closed: unknown keys fail validation. The intentional extension points are the provider names in `ai.providers`, label names in `labels`, and provider-specific JSON in `modelSettings`; these dynamic maps remain supported but have bounded entry counts, nesting, strings, arrays, and numeric values. `modelSettings` numbers may be negative or fractional when a provider supports them, but their absolute magnitude may not exceed 1,000,000. Lists, strings, provider and label counts, and validation-command count are also bounded before a coordinator can consume them.

Every operation limit has a global ceiling. Review context is limited to 20 findings of each kind, 5 MiB of diff, and 1,000 files. Audit publication is limited to 20 issues and issue triage to 200 open-issue summaries. A repair can be at most 100 files, 10,000 changed lines, 5 MiB total, and 1 MiB per file. Auto-merge is limited to 50 files and 5,000 changed lines. These ceilings are intentionally above the starter policy while preventing a trusted-policy mistake from turning into unbounded work.

`repository.automationBranchPrefix` must be a repository-relative, slash-terminated safe Git-ref prefix. Configured owner logins are trimmed and normalized to lowercase; duplicate owners after normalization are rejected, and manual issue/fix authorization compares actors with that same case-insensitive form.

## Provider and coordinator settings

Each coordinator mode is independent under `ai.agents.review`, `audit`, `issue`, and `fix`. It selects a provider from `ai.providers`, a model, attempt/turn limits, JSON model settings, and an optional Codex workspace specialist. The JSON below is a partial excerpt; use the [starter policy](../.github/codekeeper.json) for the complete required four-mode `agents` object.

```json
{
  "ai": {
    "tracing": {
      "enabled": true,
      "includeSensitiveData": false
    },
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "api": "responses",
        "structuredOutputs": true,
        "supportsReasoningEffort": true
      },
      "deepseek": {
        "baseUrl": "https://api.deepseek.com",
        "api": "chat_completions",
        "structuredOutputs": false,
        "supportsReasoningEffort": false
      }
    },
    "agents": {
      "issue": {
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "effort": "none",
        "maxTurns": 2,
        "maximumAttempts": 2,
        "workspace": {
          "enabled": false,
          "allowWrites": false,
          "model": "gpt-5.6-sol",
          "effort": "low"
        }
      }
    }
  }
}
```

Provider base URLs must use HTTPS. Explicit loopback HTTP is accepted only for local self-hosted development (`localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`); embedded credentials and URL fragments are rejected. OpenAI-compatible Responses and Chat Completions APIs need no source changes. Non-compatible protocols need a deliberately scoped `ModelProvider` implementation in `agents-runtime.mjs`.

`model_api_key` maps the selected mode’s provider credential. It is required in every reusable workflow and never falls back to an OpenAI key. The optional Codex specialist uses `workspace_api_key`; `openai_api_key` remains only as a compatibility fallback for that OpenAI-only workspace action.

## Adopter-owned coordinator profiles

The installer creates all four fixed profile paths in the adopter repository. The runtime loads the selected Markdown file into the Agents SDK coordinator instructions inside an immutable safety and authorization envelope.

| Mode | Fixed adopter path | Judgment responsibility |
|---|---|---|
| review | `.github/codekeeper/agents/pr-reviewer.md` | PR summary, evidence-backed findings, risk, test adequacy, and merge recommendation. |
| issue | `.github/codekeeper/agents/issue-triager.md` | Issue classification, actionability, missing information, and duplicate assessment. |
| audit | `.github/codekeeper/agents/repository-auditor.md` | Audit evidence, category and priority calibration, and report/no-action decisions. |
| fix | `.github/codekeeper/agents/maintenance-planner.md` | Bounded implementation planning, risk decisions, and no-change decisions. |

Edit these Markdown files through the adopter's normal review process. A merged default-branch edit affects later runs without a runtime release. The workflow rejects missing, empty, non-UTF-8, oversized, symlinked, or wrong-path profiles. It records the default-branch source commit and profile SHA-256, freezes the exact bytes for the workspace and coordinator, carries them through sealing, and refuses publication if the trusted profile has changed since preparation.

Profiles may tune evidence thresholds, severity and priority calibration, test expectations, duplicate criteria, repair-risk judgment, positive no-action cases, and report wording. They may not:

- Enable a caller or authorize a repair, issue closure, push, pull request, or merge.
- Expand `allowedPaths`, bypass `protectedPaths`, raise resource limits, or skip deterministic validation.
- Change the frozen event, task mode, issue or pull-request target, source commit, or configured owner.
- Grant tools, credentials, network access, or permission to follow instructions found in repository, issue, pull-request, comment, diff, specialist, or model content.

Those permissions remain deterministic in the caller, frozen policy, schema, validator, and publication code. If a profile conflicts with one of those controls, the run ignores the conflicting instruction and fails safely.

The currently pinned earlier installer checkpoint does not gain this behavior merely because a newer Markdown file exists. Adopter-owned profiles and the repair contracts below require an installer pin to the final source checkpoint that implements them.

## Caller automation controls

Reusable workflow callers expose explicit controls alongside `enabled`:

- `auto_review` defaults to `true` and permits eligible pull-request events to run the review workflow. Setting it to `false` skips automatic review; the supplied required review gate then fails closed.
- `auto_triage` defaults to `true` and permits only `issues` events with actions `opened`, `reopened`, or `edited`. Setting it to `false` skips those automatic events, while exact `/codekeeper triage` comments from configured owners remain available.
- `dry_run=true` makes maintenance report-only. A live run can repair only when `audit.repair.enabled=true` and every patch limit passes.

Automatic issue triage may label, publish a sticky comment, and mark a high-confidence duplicate candidate. It does not close issues; `issues.closeExactDuplicates` is an independent policy setting and remains `false` in the starter policy.

## Explicit repair targets

Capabilities decide which automatic actions can run.

- **Maintenance:** a live scheduled or manual run may create one repair when `audit.repair.enabled=true`. A dry run remains report-only.
- **Issue:** when `issues.allowAiImplementation=true`, trusted triage may add `codekeeper:ready` to a clear, bounded issue. That label starts a fix run which may create one bounded repair pull request. A configured owner may also provide an issue through manual dispatch.
- **Same-repository pull request:** the same exact owner command may target an eligible open, non-draft pull request to the default branch. A valid repair is committed and pushed to that pull request's existing head branch. The publisher never calls the create-pull-request path for this target and has no fallback that opens a second pull request. Forks, default/protected head branches, stale heads, branch movement, or target drift fail closed.

Profiles can decide that an enabled repair is too risky and return no change. They cannot turn on a disabled capability or bypass its fixed limits.

## Workspace specialists

The coordinator itself is one tool-less Agents SDK `Agent` per mode. Codex is optional and is used only as a checkout-aware specialist whose result remains untrusted evidence for the coordinator. The Codex job and coordinator run on separate fresh runners: the coordinator rebuilds trusted context, checks its digest against the workspace job output, consumes specialist JSON and any audit/fix patch as untrusted artifacts, and applies that patch only after model execution.

| Mode | Default provider | Workspace behavior |
|---|---|---|
| review | OpenAI | Optional read-only inspection of the exact PR head. |
| audit | OpenAI | Optional inspection; write access requires `audit.repair.enabled=true` and a live run. |
| issue | DeepSeek V4 Flash | Disabled by default; optional workspace is always read-only. |
| fix | OpenAI | Optional implementation; write access also requires `issues.allowAiImplementation=true`. |

Review and issue workspace writes are rejected by config validation. The installer lets the adopter choose `audit.repair.enabled`, `issues.allowAiImplementation`, and `merge.enabled`. A capability that is on is active for its matching live workflow.

## Bounded review context and auto-merge

`review.maximumDiffBytes` is a streaming capture bound: only that many diff bytes are retained in frozen coordinator context, and exceeding it terminates the diff process. When capture completes, `bytes` is exact; when it terminates, `truncated=true`, `bytesExact=false`, and `bytes` is an observed lower bound. `review.maximumChangedFiles` bounds the changed-file list; a review fails safely before prompting if that bound is exceeded. Set `includeDiffInAgentContext=false` only for a deliberate no-diff workflow; it makes deterministic auto-merge ineligible.

Auto-merge additionally fails closed when frozen diff context is truncated. It never relies on model compliance or the presence of a workspace specialist.

Version 2 auto-merge is intentionally limited to a same-repository pull request opened by the configured GitHub App bot from the configured automation branch prefix. `merge.allowUserPullRequests` must remain `false`; user pull-request auto-merge needs byte- and binary-aware metadata that this version does not transport.

## Tracing

Tracing is enabled by default with `includeSensitiveData=false`. When tracing is enabled, callers must map a separate OpenAI `trace_api_key`, including modes that use DeepSeek or any other provider. The runtime fails closed if that key is absent or, after normalization, equals the provider/model key.

View runs at [OpenAI Platform Traces](https://platform.openai.com/traces), under **Logs > Traces**. Treat trace access as operationally sensitive. Do not turn on `includeSensitiveData` without an explicit data-handling review.
