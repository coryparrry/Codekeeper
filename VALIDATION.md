# Validation

Run these checks before publishing a source release or changing reusable workflows:

```bash
node tools/codekeeper/src/cli.mjs check-config
cd tools/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
```

`npm run check` also regenerates the production tooling inventory in memory and fails unless [`tools/codekeeper/tooling-manifest.json`](tools/codekeeper/tooling-manifest.json) exactly matches it. The manifest's SHA-256 is deliberately embedded in the four source workflows: release changes to the production tooling must update the generated manifest and its four pinned workflow digests together. The top-level release manifest remains a separate release-owner responsibility.

## Decision-quality evaluation

The deterministic fixture gate exercises the production prompt builders, coordinator profiles, schemas, and provider adapter with a fake provider. It makes no network or paid-provider calls and writes neither provider outputs nor credentials:

```bash
cd tools/codekeeper && npm run eval:offline
```

The live gate is explicit and is not part of `npm run check`. A mixed run requires both `OPENAI_API_KEY` and `DEEPSEEK_API_KEY`; an OpenAI-preset run requires `OPENAI_API_KEY`. Under the default tracing policy it also requires a distinct `CODEKEEPER_TRACE_API_KEY`. The runner resolves keys per configured provider before any provider call, never prints or writes them, and reports only scenario, preset, model, attempt, safe execution stage, and pass/fail; do not redirect its output or provide secrets through command-line arguments:

```bash
cd tools/codekeeper && npm run eval:live -- --preset mixed --repeat 3
cd tools/codekeeper && npm run eval:live -- --preset openai --repeat 3
```

For an authorized OpenAI issue-triage release decision, run the same OpenAI matrix with one candidate at a time and select the first all-pass result deliberately. These commands are evaluation overrides only; they do not change the shipped policy:

```bash
cd tools/codekeeper && npm run eval:live -- --preset openai --openai-issue terra-medium --repeat 3
cd tools/codekeeper && npm run eval:live -- --preset openai --openai-issue terra-high --repeat 3
cd tools/codekeeper && npm run eval:live -- --preset openai --openai-issue sol-high --repeat 3
```

Passing an offline or live decision gate proves only the bounded fixture assertions. It does not authorize GitHub mutations, repairs, model changes, or a release.

## Source-release integrity

Run the release command only from a clean checkout at the immutable commit to publish. It creates a deterministic `git archive` from tracked Git content, unpacks it for verification, checks the full manifest and file inventory, and prints the archive SHA-256. Choose an output directory outside this checkout:

```bash
git status --short
mkdir -p ../codekeeper-release-artifacts
bash scripts/release-source.sh --output ../codekeeper-release-artifacts
```

An empty `git status --short` is required. The command refuses a dirty checkout and never copies working-tree-only files, so `.git`, `node_modules`, `.claude`, `__MACOSX`, profiler output, and macOS metadata cannot enter the archive. To validate the same integrity gate without retaining an archive:

```bash
bash scripts/release-source.sh --verify
```

`MANIFEST.sha256` intentionally covers every tracked file except itself. When a tracked file changes, regenerate the manifest in the authorized release update, then run the command again. The repository workflow runs this check for every tracked-file pull request and push.

This proves only the source archive. It does not prove that a GitHub release has been created, staged, made visible, or that a caller pins the intended commit; verify those GitHub-side facts separately.

The repository workflow also runs the Node test suite, Actionlint, and YAML parsing for every tracked-file pull request and push.

The tests cover provider selection, versioned coordinator-profile loading, separate tracing credentials, contract-invalid agent retry, bounded automatic issue triage plus configured-owner manual triage and fix authorization, policy and label ownership, bounded prompt context, artifact sealing, patch limits, fresh-checkout verification, current PR identity, App-owned markers, auto-merge eligibility, reusable-workflow contracts, and source-release manifest integrity. Regenerate and verify `MANIFEST.sha256` when release files change.

These local checks do not prove an adopter installation. Before enabling writes, run the maintenance workflow with `dry_run=true`, then verify a same-repository default-branch PR using the adopter's GitHub App, secrets, branch rules, and path policy. Confirm the review caller is evaluated from its default-branch `pull_request_target` definition and never checks out or executes PR code. Forks, merge queues, non-default PR targets, and GitHub Enterprise Server are outside the supported surface.

The local suite does not export live traces. In an adopter run, provide the separate `trace_api_key` required by the default `ai.tracing.enabled=true` policy, keep `includeSensitiveData=false`, and confirm the run appears at [OpenAI Platform Traces](https://platform.openai.com/traces) / **Logs > Traces**. Do not map a non-OpenAI provider key to this trace-export credential.
