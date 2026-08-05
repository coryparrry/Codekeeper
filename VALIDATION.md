# Validation

Run these checks before publishing a source release or changing reusable workflows:

```bash
node tools/codekeeper/src/cli.mjs check-config
cd tools/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
```

The repository workflow also runs the Node test suite, Actionlint, and YAML parsing when maintainer workflows, caller templates, or tooling change.

The tests cover provider selection, versioned coordinator-profile loading, separate tracing credentials, contract-invalid agent retry, bounded automatic issue triage plus configured-owner manual triage and fix authorization, policy and label ownership, bounded prompt context, artifact sealing, patch limits, fresh-checkout verification, current PR identity, App-owned markers, auto-merge eligibility, and reusable-workflow contracts. Regenerate and verify `MANIFEST.sha256` when release files change.

These local checks do not prove an adopter installation. Before enabling writes, run the maintenance workflow with `dry_run=true`, then verify a same-repository default-branch PR using the adopter's GitHub App, secrets, branch rules, and path policy. Confirm the review caller is evaluated from its default-branch `pull_request_target` definition and never checks out or executes PR code. Forks, merge queues, non-default PR targets, and GitHub Enterprise Server are outside the supported surface.

The local suite does not export live traces. In an adopter run, provide the separate `trace_api_key` required by the default `ai.tracing.enabled=true` policy, keep `includeSensitiveData=false`, and confirm the run appears at [OpenAI Platform Traces](https://platform.openai.com/traces) / **Logs > Traces**. Do not map a non-OpenAI provider key to this trace-export credential.
