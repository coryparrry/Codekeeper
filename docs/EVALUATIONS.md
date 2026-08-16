# Evaluating Codekeeper reviews

Codekeeper has two evaluation layers:

- `eval:offline` checks deterministic decision scenarios without provider calls.
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
| Clean control | A bounded refactor changes no behavior | Report no findings |
| Large change | A pull request changes more than 5,000 lines | Use the configured high-risk review path |

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

## Create the answer key

Store the answer key outside the fixture repository:

```json
{
  "version": 1,
  "name": "multi-domain-review",
  "repeat": 3,
  "expectedRecommendation": "block",
  "cases": [
    {
      "id": "archive-containment",
      "category": "Security",
      "expectedFiles": ["src/archive.mjs"],
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

`run.json` is optional. It can contain `runId`, `runUrl`, and `headSha`.

## Score the suite

```bash
cd tools/codekeeper
npm run eval:live-review -- \
  --manifest /secure/local/answer-key.json \
  --runs-directory /secure/local/runs \
  --json-output /secure/local/report.json \
  --markdown-output /secure/local/report.md
```

The scorer reports detection, false positives, precision, blocking classification, merge-recommendation accuracy, and optional left-to-right diagram compliance. Output files use create-only semantics so a later run cannot overwrite earlier evidence.

Detection and blocking are separate measurements. A finding counts as detected when it identifies the expected file, even if it is placed in the wrong blocking bucket. The strict suite still fails that run and records the classification error.

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

Three consistent runs across several defect categories are useful release evidence, but they do not prove general reliability. Expand the suite with clean pull requests, missing-test cases, platform-specific behavior, large diffs, hidden high-risk changes, deferred review work, issue implementation, and issue closure.
