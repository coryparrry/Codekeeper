# Validation

For agent edits, classify the touched paths and run the boundary-specific gates in
[docs/AGENT_RELEASE_SAFETY.md](docs/AGENT_RELEASE_SAFETY.md) before treating this
checklist as complete.

Run these checks before publishing a source release or changing reusable workflows:

```bash
npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund && npm run check
cd tools/codekeeper && npm ci --ignore-scripts --no-audit --no-fund
node src/cli.mjs check-config --config ../../.github/codekeeper.json
npm run check
cd ../../packages/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
cd ../../acceptance && npm run check
```

The root `packageManager` and self-test workflow pin the same npm release. Package publication must use `npm run package:pack -- --destination /absolute/output/directory`; that command builds the verified stage, installs the exact installer lock, bundles the complete Ink/React graph required by npm 12, and rejects a mismatched npm executable before creating the tarball.

The maintainer `npm run check` also verifies the complete source-release inventory and fails unless [`MANIFEST.sha256`](MANIFEST.sha256) exactly covers every tracked file except itself. The runtime check regenerates the production tooling inventory in memory and fails unless [`tools/codekeeper/tooling-manifest.json`](tools/codekeeper/tooling-manifest.json) exactly matches it. Reusable workflows acquire and reverify the exact package by version, SRI, manifest digest, and source commit; they deliberately do not embed a second tooling-manifest digest. The installer suite covers the strict repository-artifact catalog, copied Markdown rendering and digest checks, generated assets, fixed agent-profile paths, preflight failures, secret boundaries, Git recovery, the terminal flow, and the packed entrypoint. The catalog tests must prove additions, prior-target renames, release-owned retirements, duplicate rejection, destination confinement, and optional activation without adding another reconciliation path. The acceptance suite remains offline and uses only its deterministic fixture.

## Decision-quality evaluation

The deterministic fixture gate exercises the production prompt builders, packaged profile defaults and adopter overrides, schemas, and provider adapter with a fake provider. It makes no network or paid-provider calls and writes neither provider outputs nor credentials:

```bash
cd tools/codekeeper && npm run eval:offline
```

The live gate is explicit and is not part of `npm run check`. A mixed run requires both `OPENAI_API_KEY` and `DEEPSEEK_API_KEY`; an OpenAI-preset run requires `OPENAI_API_KEY`. Under the default tracing policy it also requires a distinct `CODEKEEPER_TRACE_API_KEY`. The runner resolves keys per configured provider before any provider call, never prints or writes them, and reports only scenario, preset, model, attempt, safe execution stage, and pass/fail; do not redirect its output or provide secrets through command-line arguments:

```bash
cd tools/codekeeper && npm run eval:live -- --preset mixed --repeat 3
cd tools/codekeeper && npm run eval:live -- --preset openai --repeat 3
```

For release-relevant response evaluation, repeat a complete GitHub review against one immutable pull-request head, retain each sealed result, and grade the runs with the answer key kept outside the adopter repository:

```bash
cd tools/codekeeper
npm run eval:live-review -- \
  --manifest /secure/local/answer-key.json \
  --runs-directory /secure/local/runs \
  --json-output /secure/local/report.json \
  --markdown-output /secure/local/report.md
```

See [evaluating Codekeeper reviews](docs/EVALUATIONS.md) for fixture design, repeat strategy, artifact layout, metrics, and the boundary between an intentional blocking gate failure and an infrastructure failure.

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

The repository workflow runs the maintainer suite, the installer suite on the pinned Node 22 and 24 LTS releases, the offline acceptance-harness suite, Actionlint, and YAML parsing for every tracked-file pull request and push.

The tests cover provider selection, trusted default-branch profile loading, fixed paths, byte freezing, profile provenance and drift rejection, separate tracing credentials, contract-invalid agent retry, bounded automatic issue triage and issue implementation, configured-owner commands, policy and label ownership, live maintenance repair, dry runs, bounded prompt context, artifact sealing, patch limits, fresh-checkout verification, current PR identity, App-owned markers, same-PR non-force updates without a create-pull-request fallback, auto-merge eligibility, reusable-workflow contracts, and source-release manifest integrity. Regenerate and verify `MANIFEST.sha256` when release files change.

These local checks do not prove an adopter installation. Before enabling writes, confirm the installer metadata pins the final source checkpoint that implements optional profile overrides and same-PR repair; an older embedded pin does not acquire those behaviors from a newer tarball. Then prove the following in a private disposable adopter repository:

1. Install with every `.github/codekeeper/agents/*.md` path absent, merge to the default branch, and run `codekeeper verify` from a clean checkout. Confirm its installed-file, setting-name, App-scope, exact-package, and credential-free runtime checks pass. If App proof is unavailable to the current GitHub token, treat the result as unproven rather than passed.
2. Run `codekeeper verify --controlled`; confirm the maintenance dry run uses packaged profile provenance. This proves model execution and sealing, but not App token minting or publication.
3. With `audit.repair.enabled=true`, run live maintenance and verify that only one allowed, validated patch can reach publication.
4. Create one agent profile override through a normal pull request. Show that the unmerged branch does not affect a run, then show that a later run records and uses the merged default-branch profile digest while the other roles still use packaged defaults.
5. Open a controlled same-repository pull request targeting the default branch. Confirm the review caller is evaluated from its default-branch `pull_request_target` definition, never checks out or executes PR code, and proves App-authored publication before its gate is made required.
6. Post a comment whose complete body is `/codekeeper fix` as a configured owner. Verify the App advances the existing pull request's head with a non-force commit, does not open another pull request, and refuses a stale or moved head.
7. Open a separate controlled issue. Verify trusted triage marks it ready and automatically starts at most one bounded, unmerged repair pull request when issue implementation is on.

Record workflow-run, issue, pull-request, review, and App-owned commit URLs as evidence. Restore `CODEKEEPER_ENABLED=false` after proof. Forks, merge queues, non-default PR targets, and GitHub Enterprise Server are outside the supported surface.

The local suite does not export live traces. In an adopter run, provide the OpenAI trace-export key and keep sensitive tracing off unless the evaluation explicitly needs prompts and responses. Confirm the trace appears in OpenAI **Logs > Traces**. Do not map a model-provider key to the trace-export credential.
