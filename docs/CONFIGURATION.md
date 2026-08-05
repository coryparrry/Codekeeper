# Configuration

The adopter-owned `.github/ai-maintainer.json` is the only runtime policy file. It is read from the adopter default branch, validated before every coordinator run, copied into the sealed artifact, and hash-checked again before publication.

## Provider and coordinator settings

Each coordinator mode is independent under `ai.agents.review`, `audit`, `issue`, and `fix`. It selects a provider from `ai.providers`, a model, attempt/turn limits, JSON model settings, and an optional Codex workspace specialist. The JSON below is a partial excerpt; use the [starter policy](../.github/ai-maintainer.json) for the complete required four-mode `agents` object.

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

## Workspace specialists

The coordinator itself is one tool-less Agents SDK `Agent` per mode. Codex is optional and is used only as a checkout-aware specialist whose result remains untrusted evidence for the coordinator. The Codex job and coordinator run on separate fresh runners: the coordinator rebuilds trusted context, checks its digest against the workspace job output, consumes specialist JSON and any audit/fix patch as untrusted artifacts, and applies that patch only after model execution.

| Mode | Default provider | Workspace behavior |
|---|---|---|
| review | OpenAI | Optional read-only inspection of the exact PR head. |
| audit | OpenAI | Optional inspection; write access also requires `audit.repair.enabled=true`. |
| issue | DeepSeek V4 Flash | Disabled by default; optional workspace is always read-only. |
| fix | OpenAI | Optional implementation; write access also requires `issues.allowAiImplementation=true`. |

Review and issue workspace writes are rejected by config validation. `audit.repair.enabled`, `issues.allowAiImplementation`, and `merge.enabled` are all false in the starter policy.

## Bounded review context and auto-merge

`review.maximumDiffBytes` is a streaming capture bound: only that many diff bytes are retained in frozen coordinator context, and exceeding it terminates the diff process. When capture completes, `bytes` is exact; when it terminates, `truncated=true`, `bytesExact=false`, and `bytes` is an observed lower bound. `review.maximumChangedFiles` bounds the changed-file list; a review fails safely before prompting if that bound is exceeded. Set `includeDiffInAgentContext=false` only for a deliberate no-diff workflow; it makes deterministic auto-merge ineligible.

Auto-merge additionally fails closed when frozen diff context is truncated. It never relies on model compliance or the presence of a workspace specialist.

## Tracing

Tracing is enabled by default with `includeSensitiveData=false`. When tracing is enabled, callers must map a separate OpenAI `trace_api_key`, including modes that use DeepSeek or any other provider. The runtime fails closed if that key is absent or, after normalization, equals the provider/model key.

View runs at [OpenAI Platform Traces](https://platform.openai.com/traces), under **Logs > Traces**. Treat trace access as operationally sensitive. Do not turn on `includeSensitiveData` without an explicit data-handling review.
