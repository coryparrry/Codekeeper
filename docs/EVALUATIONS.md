# Evaluating Codekeeper reviews

Codekeeper has three evaluation layers:

- `eval:offline` checks deterministic decision scenarios without provider calls.
- `eval:live` runs the same bounded scenarios through configured providers.
- `eval:live-review` grades sealed results from complete GitHub review workflows.

The live layer is release-relevant. A prompt-only pass does not prove that checkout, tests, workspace analysis, schema validation, sealing, or publication work together.

## Build a live suite

Use a private, disposable adopter repository. Create pull requests with independent and deterministic defects from several domains. Keep the answer key outside the repository until all runs finish so the agent cannot discover the expected findings.

Include these fixture types:

| Category | Fixture shape | Expected behavior |
| --- | --- | --- |
| Security | Untrusted archive entry escapes its extraction root | Block at the containment boundary |
| Concurrency | Overlapping reservations pass a check-before-write race | Block at the atomicity boundary |
| API contract | A public request uses the wrong parameter | Block at the request builder |
| Boundary regression | An expiry check rejects an exact still-valid value | Block at the comparison |
Keep a deterministic failing test for every planted defect and passing tests for nearby behavior. Do not name the expected files or defects in the pull-request title or description.

Disable competing automatic reviewers for the fixture. Their comments can contaminate the review context or replace an in-progress run. Exclude interrupted or contaminated attempts and record the reason.

## Repeat an immutable head

Run the same pull-request head at least three times. Do not add empty commits between repeats. Use the configured owner rerun command so every run evaluates the same SHA.

For each run, retain:

- workflow URL and run ID;
- exact pull-request head SHA;
- sealed `codekeeper-review-artifact-<run-id>` artifact;
- published review comment;
- job and model timing reported by the workflow.

A correct blocking review can leave the workflow red because the review gate is doing its job. Treat that separately from package, analysis, validation, sealing, or publication failures.

## Create the version-two answer key

Store the answer key outside the fixture repository:

```json
{
  "version": 2,
  "name": "multi-domain-review",
  "repeat": 3,
  "expectedHeadSha": "0123456789abcdef0123456789abcdef01234567",
  "expectedRecommendation": "block",
  "cases": [
    {
      "id": "archive-containment",
      "category": "Security",
      "expectedFiles": ["src/archive.mjs"],
      "rootCauseTags": ["path-traversal", "containment-before-write"],
      "expectedLineRanges": [[42, 67]],
      "reproductionTest": "test/archive-containment.test.mjs",
      "blocking": true
    }
  ]
}
```

An expected file can belong to only one case. This keeps matching deterministic and avoids grading model wording. A human must still inspect each explanation and reproduction.

## Arrange downloaded runs

Place every sealed result in its own directory:

```text
runs/
  001/
    result.json
    run.json
  002/
    result.json
    run.json
```

Every directory must contain `run.json` with the same full `headSha` as `manifest.expectedHeadSha`. It can also contain `runId`, `runUrl`, and `resultSchemaVersion`:

```json
{
  "runId": 3187,
  "runUrl": "https://github.com/example/repository/actions/runs/3187",
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "resultSchemaVersion": 2
}
```

Stamping `resultSchemaVersion: 2` records the v2 contract for a raw sealed result without modifying its runtime JSON. The scorer rejects a missing or different head before aggregation.

Each case must identify the expected file, one or more stable root-cause tags, and whether the result is required to block. `expectedLineRanges` and `reproductionTest` are optional constraints: when present, a finding must identify a matching changed line and the exact repository-local reproduction test. Tags are lower-cased and compared as a required subset, so an answer may add more specific tags without changing the expected key. Paths are repository-relative and traversal is rejected.

The evaluator accepts version-one keys and unversioned/direct run results only for migration diagnostics. They can still report file localization, but they are explicitly marked legacy and can never be a semantic pass. A version-two result must carry `schemaVersion: 2` either in `run.json` as `resultSchemaVersion: 2`, on the result object, or in a `{ "schemaVersion": 2, "result": ... }` envelope. The raw sealed Codekeeper result keeps its existing runtime keys; stamp the schema in `run.json` or use the evaluator-only envelope rather than adding a top-level key that the runtime result schema does not allow. Every finding must include non-empty `rootCauseTags`. Missing or malformed evidence is rejected before scoring.

## Score the suite

```bash
cd tools/codekeeper
npm run eval:live-review -- \
  --manifest /secure/local/answer-key.json \
  --runs-directory /secure/local/runs \
  --json-output /secure/local/report.json \
  --markdown-output /secure/local/report.md
```

The scorer reports file localization, root-cause semantic correctness, optional line-range and reproduction-test agreement, false positives, precision, blocking classification, merge-recommendation accuracy, and optional left-to-right diagram compliance. Output files use create-only semantics so a later run cannot overwrite earlier evidence. JSON and Markdown reports include the report schema, scorer version, the answer-key SHA-256, and one SHA-256 for each run result. These digests are computed over deterministic canonical JSON with recursively sorted object keys.

The command writes both reports and exits non-zero unless all requested repeats exist and every run passes. Keep the reports from a failed command as diagnostic evidence.

File localization and semantic correctness are separate measurements. A finding counts as file-localized when it identifies an expected file, even if it names the wrong defect. Such a finding is a semantic miss. Blocking is a third measurement: a semantically correct finding in the wrong blocking bucket is still recorded as a blocking-classification error. The strict suite passes only when every case is localized, semantically correct, correctly classified, and free of false positives.

Severity and blocking are also separate. A low-severity finding can block when the pull request introduces a current, reproducible contract violation with concrete impact and a bounded fix. Missing coverage alone, style preferences, pre-existing defects, and incomplete evidence remain non-blocking.

## Compare quality and latency

Change one variable at a time. Keep the pull-request head, answer key, provider, model, effort, and output limits fixed unless one of those values is the subject of the comparison.

Use at least three sequential repeats. Compare correctness before speed. Record:

- strict pass rate and per-category recall;
- false positives and precision;
- provider errors, retries, and token limits;
- model duration and complete workflow duration;
- workspace, coordination, sealing, and publication job duration;
- token use and cost when the provider reports them.

Do not treat one successful run as release evidence. Do not compare concurrent runs when provider rate limits or shared runner load can change the result. Model-call duration is not the same as end-to-end workflow duration.

## Interpret results

Review validation keeps a finding only when its file belongs to the pull-request diff. A line outside the changed hunks is reduced to file-level evidence instead of being moved to a guessed line.

Three consistent runs across several defect categories are useful release evidence, but they do not prove general reliability. Expand automated review scoring with missing-test cases, platform-specific behavior, and misleading but non-defective changes.

## Manual E2E controls

The review scorer accepts only review results with one non-empty version-two answer key for a strict pass. Test these separate flows as distinct pull requests or issues and retain their GitHub state as manual acceptance evidence:

| Flow | Evidence to retain |
| --- | --- |
| Clean pull request under 5,000 changed lines | Exact head, no unsupported findings, expected review tier, and final gate result |
| Pull request over 5,000 changed lines | Exact head, changed-line count, high-risk routing metadata, and review result |
| Hidden high-risk change under 5,000 lines | Exact head, planted risk boundary, blocking finding, and review result |
| Deferred review work | Review comment, created issue, source pull request, and exact deferred finding |
| Issue implementation and closure | Original issue, fixer pull request, merged commit, closing reference, and final closed state |

Do not place these different heads in one `eval:live-review` runs directory. They test workflow routing and GitHub mutation boundaries that the review-result scorer does not grade.
