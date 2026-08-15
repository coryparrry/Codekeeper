# Evaluating Codekeeper reviews

Codekeeper has two complementary evaluation layers:

- `eval:braintrust` runs bounded decision scenarios directly through a configured coordinator and exports the model trace.
- `eval:live-review` grades sealed results from complete GitHub review workflows, including the immutable pull-request head, Luna workspace evidence, coordinator decision, publication boundary, and Braintrust export.

The live layer is release-relevant. A prompt-only pass does not prove that repository checkout, tests, workspace evidence, schema validation, tracing, sealing, or publication work together.

## Build a live suite

Use a private disposable adopter repository. Create one pull request that contains independent, deterministic defects from several domains. Keep the answer key outside that repository until the runs finish so the workspace agent cannot discover expected findings.

Disable competing automatic reviewers for the fixture, or remove their comments before the first counted run. Their findings contaminate the review context, and feedback events can also replace an in-progress run through the repository's concurrency policy. Exclude any interrupted or contaminated attempt from model scoring and record why it was excluded.

| Category | Fixture shape | Expected review behavior |
|---|---|---|
| Security | Untrusted archive entry escapes its extraction root | Blocking finding at the containment boundary |
| Concurrency | Two overlapping reservations both pass a check-before-write race | Blocking finding at the atomicity boundary |
| API contract | A continuation cursor is serialized under the wrong public parameter | Blocking finding at the request builder |
| Subtle regression | An expiry check evicts a value at the exact still-valid boundary | Blocking finding at the boundary comparison |

Keep one deterministic failing test for each planted defect and passing tests for nearby behavior. Do not put category names, expected files, or explanations in the pull-request title or description.

## Repeat the identical head

Run the same immutable pull-request head at least three times. Repeats must not add empty commits because that changes the evaluated head. Request `/codekeeper rerun` through the configured owner command so the trusted GitHub App dispatches another review for the current SHA.

For each run, retain the workflow URL, exact head SHA, sealed `codekeeper-review-artifact-<run-id>` artifact, Braintrust trace, and published review comment. The overall GitHub run is expected to be red when a correct review publishes blocking findings. Distinguish that intentional gate failure from failures in bootstrap, workspace analysis, Braintrust export, validation, sealing, or publication.

## Answer-key manifest

Create a local manifest that is never committed to the target repository:

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

An expected file may belong to only one case. This makes matching deterministic and avoids fragile grading based on model wording. It establishes evidence localization, not full semantic equivalence; a human should still inspect the explanation and reproduction.

## Arrange downloaded runs

Place each sealed result in a separate directory. `run.json` is optional but makes the Markdown report auditable:

```text
runs/
  001/
    result.json
    run.json
  002/
    result.json
    run.json
```

`run.json` may contain `runId`, `runUrl`, and `headSha`.

## Score and document results

```bash
cd tools/codekeeper
npm run eval:live-review -- \
  --manifest /secure/local/answer-key.json \
  --runs-directory /secure/local/runs \
  --json-output /secure/local/report.json \
  --markdown-output /secure/local/report.md
```

The scorer reports per-category and aggregate recall, false positives and precision, blocking classification, merge-recommendation accuracy, and optional `flowchart LR` compliance. Output files use create-only semantics so a later run cannot silently overwrite prior evidence.

## Interpret Braintrust traces

The Braintrust span captures the final coordinator input and response, including the authoritative Luna workspace result. It does not currently expose Luna's internal workspace tool-call spans. Use the trace to inspect evidence handoff, token use, latency, retries, and the structured final response; use the sealed artifact and GitHub run for end-to-end authority and publication evidence.

Review validation keeps a finding only when its file belongs to the pull-request diff. A model-supplied line outside that file's changed hunks is safely reduced to a file-level finding instead of discarding the complete review. This avoids guessing a replacement line while preserving the supported explanation and blocking decision.

One strong run is a smoke test. Three consistent runs across four independent defect categories are better evidence, but they still do not establish general reliability. Expand the suite with clean no-finding pull requests, missing-test cases, platform-specific behavior, large diffs, and intentionally misleading but non-defective changes.
