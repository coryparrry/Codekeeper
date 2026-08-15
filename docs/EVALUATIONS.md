# Evaluating Codekeeper reviews

Codekeeper has two complementary evaluation layers:

- `eval:braintrust` runs bounded decision scenarios directly through a configured coordinator and exports the model trace.
- `eval:live-review` grades sealed results from complete GitHub review workflows, including the immutable pull-request head, Luna workspace evidence, coordinator decision, publication boundary, and Braintrust export.

The live layer is release-relevant. A prompt-only pass does not prove that repository checkout, tests, workspace evidence, schema validation, tracing, sealing, or publication work together.

## Build a live suite

Use a private disposable adopter repository. Create one pull request that contains independent, deterministic defects from several domains. Keep the answer key outside that repository until the runs finish so the workspace agent cannot discover expected findings.

Disable competing automatic reviewers for the fixture, or remove their comments before the first counted run. Their findings contaminate the review context, and feedback events can also replace an in-progress run through the repository's concurrency policy. Exclude any interrupted or contaminated attempt from model scoring and record why it was excluded.

| Category          | Fixture shape                                                        | Expected review behavior                     |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Security          | Untrusted archive entry escapes its extraction root                  | Blocking finding at the containment boundary |
| Concurrency       | Two overlapping reservations both pass a check-before-write race     | Blocking finding at the atomicity boundary   |
| API contract      | A continuation cursor is serialized under the wrong public parameter | Blocking finding at the request builder      |
| Subtle regression | An expiry check evicts a value at the exact still-valid boundary     | Blocking finding at the boundary comparison  |

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

Detection and blocking classification are separate measurements. A finding in the expected file counts as detected even when the model puts it in the wrong blocking bucket; that run still fails the strict suite, and the classification metric records the downgrade without mislabeling the real defect as a false positive.

Severity and blocking are also separate decisions. Severity measures impact; blocking measures whether the pull request can safely merge. A low-severity finding should still block when the pull request introduces a current, reproducible contract violation with concrete impact and a bounded repair. Missing coverage alone, style preferences, pre-existing defects, and incomplete evidence remain non-blocking.

## 2026-08-15 Luna baseline

The first completed multi-domain live suite ran the same immutable pull-request head three times through GitHub, the Luna workspace specialist, the Braintrust coordinator exporter, schema validation, sealing, and publication. The answer key covered the four fixture shapes above.

| Measurement                         |        Result |
| ----------------------------------- | ------------: |
| Defect detection                    |  12/12 (100%) |
| Blocking classification             | 11/12 (91.7%) |
| Unrelated findings                  |             0 |
| Correct merge recommendation        |    3/3 (100%) |
| Left-to-right diagram compliance    |    3/3 (100%) |
| Runs passing every strict assertion |           2/3 |

Luna detected the security, concurrency, and API-contract defects as blocking in all three repeats. It also detected the subtle expiry-boundary regression in all three, but downgraded that finding to non-blocking once. Every repeat still recommended blocking the pull request. All three returned no diagram, which is valid under the `flowchart LR`-or-none contract.

The pre-calibration performance baseline was 5.9-6.4 seconds for the three counted Braintrust coordinator traces and 3 minutes 37 seconds to 4 minutes 17 seconds for the corresponding GitHub workflows. This calibration changes the existing classification rubric and validator only; it deliberately adds no model call. Runtime optimization is measured separately so quality changes are not confounded with pipeline changes.

Two setup attempts were excluded before scoring: one was contaminated by an automatic reviewer that disclosed the planted findings, and one bound workspace evidence to a stale default-branch configuration snapshot. An earlier diagnostic run was also excluded after semantically correct findings supplied invalid line locations; that evidence led to the file-level fallback described below. Exact run artifacts, trace records, and the answer key remain in the private acceptance environment rather than the generic product repository.

## 2026-08-15 blocking calibration result

After separating impact severity from merge blocking, the identical pull-request head was reviewed three more times through the complete GitHub workflow. The low-severity expiry-boundary defect remained blocking in every repeat without changing the other classifications.

| Measurement                         |        Before |        After |
| ----------------------------------- | ------------: | -----------: |
| Defect detection                    |  12/12 (100%) | 12/12 (100%) |
| Blocking classification             | 11/12 (91.7%) | 12/12 (100%) |
| Unrelated findings                  |             0 |            0 |
| Correct merge recommendation        |    3/3 (100%) |   3/3 (100%) |
| Left-to-right diagram compliance    |    3/3 (100%) |   3/3 (100%) |
| Runs passing every strict assertion |           2/3 |          3/3 |

The contrastive decision-quality case now requires a current, reproducible, pull-request-introduced contract violation to remain blocking even when its impact is low. A mutation test moves that supported defect into the non-blocking bucket and proves that the semantic evaluator rejects the downgrade. The schema accepts this independent classification instead of coupling every blocker to medium-or-higher severity.

| Post-calibration stage       |                     Three-run observation |
| ---------------------------- | ----------------------------------------: |
| Braintrust coordinator trace |                           5.9-6.4 seconds |
| Complete GitHub workflow     | 3 minutes 37 seconds-4 minutes 12 seconds |
| Luna workspace analysis job  |   1 minute 19 seconds-1 minute 56 seconds |
| Coordinator analysis job     |                             28-32 seconds |
| Seal job                     |                             15-18 seconds |
| Publication job              |                             17-18 seconds |

This small three-run sample shows no latency regression from the classification change: the coordinator stayed inside the pre-calibration range and the workflow maximum was five seconds lower. It is not a performance benchmark. A separate optimization phase should measure the Luna workspace job first because it is both the longest stage and the largest source of run-to-run variance. Braintrust currently times only the final coordinator span, so GitHub job timing remains necessary for that analysis.

## Braintrust reasoning-effort calibration

The Braintrust playground `Codekeeper Luna reasoning calibration` replays one frozen four-defect coordinator input through three otherwise identical GPT-5.6 Luna tasks. Only `reasoning_effort` changes: `low`, `medium`, or `high`. Braintrust's playground does not currently expose Luna's `max` effort, so comparing `max` requires a code-based evaluation rather than this UI experiment.

The custom TypeScript scorer `Codekeeper review contract` is deterministic. It assigns equal weight to eight contract checks: the review decision, exact blocking-file set, current high-confidence classification, severity mapping, finding titles, the low-severity defect remaining blocking, clean supporting fields, and the left-to-right diagram policy. The pass threshold is `1.0`. A diagram passes only when it is absent or begins with `graph LR` or `flowchart LR`; `TD` and `TB` fail. This avoids adding the latency, cost, and variance of an LLM judge to the model comparison.

The first immutable experiment snapshot for each effort produced the following successful results. The first medium attempt returned a transient `502 Bad Gateway` before scoring; its failed experiment was retained, and the separately named medium retry below succeeded.

| Effort       | Contract score | Duration | LLM duration | Time to first token | Prompt tokens | Cached prompt tokens | Completion tokens | Reasoning tokens | Total tokens | Estimated cost |
| ------------ | -------------: | -------: | -----------: | ------------------: | ------------: | -------------------: | ----------------: | ---------------: | -----------: | -------------: |
| Low          |           100% |    5.12s |        4.86s |              0.737s |         2,752 |                2,749 |               856 |               49 |        3,608 |         $0.001 |
| Medium retry |           100% |    5.38s |        4.91s |              0.594s |         2,752 |                2,749 |               902 |               95 |        3,654 |         $0.001 |
| High         |           100% |   14.47s |       14.02s |               3.17s |         2,752 |                2,749 |               899 |               92 |        3,651 |         $0.001 |

This is a calibration smoke test, not evidence that low is generally equivalent or that high is always slower. The mutable playground run also scored all three efforts at 100%, but its observed durations were 8.3, 5.4, and 6.3 seconds respectively. That variance, plus the transient gateway failure, means optimization decisions should use at least three immutable repeats per effort, run sequentially against the same dataset version. Compare correctness first, then error rate, latency percentiles, reasoning and total tokens, cache use, and cost. Keep GitHub workflow timing alongside Braintrust because this experiment covers the final coordinator only, not Luna's repository workspace analysis.

## Luna flow latency calibration v1

The [Codekeeper Luna flow latency v1 playground](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/playgrounds/Codekeeper%20Luna%20flow%20latency%20v1) extends the single coordinator smoke test into 12 frozen, source-backed cases across issue triage, pull-request review, and controlled fixes. Each case includes enough trusted contract, source, diff, or test evidence to make one exact decision while retaining realistic distractors, untrusted instructions, authority boundaries, and easy-to-miss edge cases.

The versioned local artifacts are:

- `tools/codekeeper/evals/braintrust/luna-flow-dataset-v1.json` — the portable 12-case source of truth.
- `tools/codekeeper/evals/braintrust/luna-flow-prompt-v1.md` — the shared compact prompt used by every effort.
- `tools/codekeeper/evals/braintrust/luna-flow-scorer-v1.ts` — the deterministic six-field contract scorer.
- `tools/codekeeper/evals/braintrust/luna-flow-calibration.test.mjs` — dataset, prompt, and scorer mutation tests.

The live [Codekeeper Luna flow calibration v1 dataset](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/datasets/codekeeper-luna-flow-calibration-v1) and [Codekeeper Luna flow contract scorer](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/scorers/61013cd0-2f7f-4a21-8ca9-f9accbb1f6f7) mirror those files.

| Case                                      | Flow   | Difficulty | Behavior under test                                                         | Source anchor                                                   |
| ----------------------------------------- | ------ | ---------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `issue-missing-repro-injection`           | Issue  | Easy       | Reject instruction injection and request a reproducible boundary            | `tools/codekeeper/src/lib/prompts.mjs`                          |
| `issue-exact-duplicate-stale-publication` | Issue  | Medium     | Match an exact stale-head duplicate without using component similarity      | `tools/codekeeper/src/lib/publish.mjs`                          |
| `issue-related-pagination-not-duplicate`  | Issue  | Hard       | Separate a query-key defect from a related pagination-bound defect          | `acceptance/src/harness.mjs`                                    |
| `issue-unresolved-policy-choice`          | Issue  | Hard       | Require a maintainer decision when mutation authority is ambiguous          | `tools/codekeeper/src/lib/publish.mjs`, `docs/CONFIGURATION.md` |
| `review-query-key-regression`             | Review | Easy       | Block a current API-contract regression and reject a disproved distractor   | `tools/codekeeper/evals/decision-quality.mjs`                   |
| `review-stale-head-publication`           | Review | Hard       | Detect use of an earlier pull snapshot after exact-head revalidation        | `tools/codekeeper/src/lib/publish.mjs`                          |
| `review-bounded-pagination-completeness`  | Review | Hard       | Fail closed at a full 1,000-row inventory boundary                          | `acceptance/src/harness.mjs`                                    |
| `review-clean-cache-refactor`             | Review | Hard       | Approve a constrained optimization despite plausible false positives        | `tools/codekeeper/src/lib/config.mjs`                           |
| `fix-expiry-equality-boundary`            | Fix    | Easy       | Preserve the proven equality boundary with the smallest patch               | `tools/codekeeper/evals/decision-quality.mjs`                   |
| `fix-archive-path-containment`            | Fix    | Medium     | Reject traversal, root-self, absolute, and prefix-sibling paths             | `tools/codekeeper/src/lib/workspace.mjs`                        |
| `fix-concurrent-reservation-atomicity`    | Fix    | Hard       | Make same-key reservation atomic while retaining retry and key independence | `tools/codekeeper/src/lib/publish.mjs`                          |
| `fix-protected-workflow-request`          | Fix    | Medium     | Refuse an owner-authored request outside the controlled edit boundary       | `tools/codekeeper/src/lib/prompts.mjs`                          |

### Controlled comparison

All tasks use GPT-5.6 Luna, `max_tokens: 512`, `verbosity: low`, the same prompt, the same dataset snapshot, and the same deterministic scorer. The only model parameter that changes is `reasoning_effort`: `low`, `medium`, or `high`. An exact pass requires all six output fields to match. An errored or unscored row fails the production gate even if Braintrust reports a 100% average over the remaining scored rows.

Prompt calibration found two output-contract ambiguities before the retained repetitions:

1. A one-row smoke run showed that every effort could omit `caseId`; the prompt now requires copying the exact non-empty `CASE ID:` value.
2. The first 12-case run produced 10/12 exact passes at low, 11/12 at medium, and 10/12 at high. The decisions and patch choices were correct, but some controlled-fix outputs invented PR-style finding keys. The prompt now states that only PR review emits finding and blocking keys; issue and fix arrays must remain empty. The next mutable run passed all 36 calls.

Three early immutable repetitions named `r1` through `r3` are deliberately excluded. Their frozen snapshots each contained only 11 unique case IDs, duplicated `review-stale-head-publication`, and omitted the clean control `review-clean-cache-refactor`; high `r3` also exhausted the completion ceiling on one row. This came from asynchronous saves during manual dataset entry. The authoritative dataset page was repaired and verified as 12 rows, 12 unique IDs, no missing IDs, and no duplicates before the retained runs below.

### Retained immutable results

Durations are Braintrust sums across 12 model calls, not wall-clock batch time. `LLM duration` excludes evaluation overhead. High `r4` produced the correct output on 11 rows; `review-clean-cache-refactor` reached the 512-token completion ceiling before emitting output, which Braintrust represented as two errors and no score for that row.

| Effort | Run  | Exact passes | Errors | Duration | LLM duration | TTFT sum | Completion tokens | Reasoning tokens |
| ------ | ---- | -----------: | -----: | -------: | -----------: | -------: | ----------------: | ---------------: |
| Low    | `r4` |        12/12 |      0 |   27.71s |       19.61s |    8.06s |               659 |              145 |
| Low    | `r5` |        12/12 |      0 |   15.52s |       13.68s |    4.11s |               615 |              101 |
| Low    | `r6` |        12/12 |      0 |   18.70s |       16.97s |    4.41s |               626 |              112 |
| Medium | `r4` |        12/12 |      0 |   24.14s |       16.83s |    4.77s |               848 |              322 |
| Medium | `r5` |        12/12 |      0 |   22.09s |       16.62s |    4.62s |               861 |              337 |
| Medium | `r6` |        12/12 |      0 |   20.61s |       19.06s |    4.39s |             1,088 |              560 |
| High   | `r4` |        11/12 |      2 |   28.41s |       22.41s |    4.92s |             1,452 |              960 |
| High   | `r5` |        12/12 |      0 |   20.86s |       17.34s |    5.32s |               977 |              447 |
| High   | `r6` |        12/12 |      0 |   22.47s |       20.92s |    5.17s |             1,171 |              641 |

| Effort | Production-gate result | Errors | Duration | LLM duration | Mean LLM/case | Completion tokens | Reasoning tokens |
| ------ | ---------------------: | -----: | -------: | -----------: | ------------: | ----------------: | ---------------: |
| Low    |           36/36 (100%) |      0 |   61.93s |       50.26s |         1.40s |             1,900 |              358 |
| Medium |           36/36 (100%) |      0 |   66.84s |       52.51s |         1.46s |             2,797 |            1,219 |
| High   |          35/36 (97.2%) |      2 |   71.74s |       60.67s |         1.69s |             3,600 |            2,048 |

For this 12-case flow suite, Low remains the strongest issue-and-fix calibration result. It tied medium on exact correctness, had no errors, used 7.3% less end-to-end time, 4.3% less model time, and 70.6% fewer reasoning tokens. High failed the hard reliability gate once; low used 13.7% less end-to-end time and 82.5% fewer reasoning tokens than high. Medium had a lower aggregate time-to-first-token than low because of low `r4` variance, but did not convert its extra reasoning into better accuracy or lower total latency. The larger review-specific benchmark below supersedes this suite's PR-review reasoning selection.

This result selects a reasoning level within Luna; it does not yet justify replacing the current per-flow production models. The cases reason over frozen repository evidence without workspace tools, patch application, GitHub API calls, or end-to-end publication. The next evaluation layer should compare the selected Luna effort for each flow with its incumbent model on live issue, review, and fix orchestration while recording workspace duration, tool calls, retries, patch/test outcomes, and GitHub workflow time.

## Qodo PR review calibration v1

The [Codekeeper Qodo PR review calibration v1 playground](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/playgrounds/Codekeeper%20Qodo%20PR%20review%20calibration%20v1) measures review quality on substantially larger, multi-file pull requests than the 12-case flow suite. Its [Braintrust dataset](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/datasets/codekeeper-qodo-pr-review-calibration-v1) contains 30 frozen cases selected from [Qodo PR-Review-Bench](https://huggingface.co/datasets/Qodo/PR-Review-Bench): 179 labelled issues, 334 changed files, and 891,201 diff bytes across eight repositories.

The source is pinned to revision `a73957c450a70693a743260e5637fffc44625f16`. The raw `git_code_review_bench_100_w_open_prs.jsonl` file is MIT licensed and has SHA-256 `2f0448ed1f9a55bea14039961d8d9e610ee8885b37559b80f5821f3f70cfe64d`. The repository distribution is Ghost, ASP.NET Core, Cal.com, Dify, Firefox iOS, and Prefect with four cases each, plus Redis and Tauri with three each.

The versioned local artifacts are:

- `tools/codekeeper/evals/braintrust/qodo-pr-review-selection-v1.json` — pinned source provenance and the exact 30-case selection.
- `tools/codekeeper/evals/braintrust/prepare-qodo-pr-review-bench-v1.mjs` — checksum-verifying dataset generator.
- `tools/codekeeper/evals/braintrust/qodo-pr-review-prompt-v1.md` — the shared diff-only review prompt.
- `tools/codekeeper/evals/braintrust/qodo-pr-review-prompt-v2.md` — the retained systematic Medium prompt.
- `tools/codekeeper/evals/braintrust/qodo-pr-review-scorer-v1.ts` — deterministic localization and semantic-overlap scorer.
- `tools/codekeeper/evals/braintrust/analyze-qodo-pr-review-optimization-v2.mjs` — deterministic routing, duplicate suppression, and fused-export analysis.
- `tools/codekeeper/evals/braintrust/qodo-pr-review-optimization-v2.json` — immutable experiment links, measurements, and pipeline status.
- `tools/codekeeper/evals/braintrust/qodo-pr-review-calibration.test.mjs` — selection, prompt, and scorer contract tests.

### What the scores mean

Qodo labels 88 issues as functional defects and 91 as repository-rule violations. `Qodo functional recall` is the percentage of labelled functional defects found. `Qodo precision` is the percentage of model findings matched to the answer key. `Qodo F1` balances overall recall with precision. `Qodo impact recall` is a Codekeeper metric that weights functional defects twice as heavily as rule violations; Qodo does not provide native severity labels, so this must not be described as severity-weighted recall.

The scorer requires the exact normalized file, a line inside or within three lines of the labelled range, and sufficient semantic overlap. It performs one-to-one matching so one finding cannot claim multiple answer-key issues. This makes the result deterministic, but it can undercount a useful finding when the answer key is incomplete or the model anchors a real defect outside the narrow labelled range.

### Run controls and exclusions

Every retained experiment used GPT-5.6 Luna, `verbosity: low`, the same prompt, dataset version, and [Qodo metrics scorer](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/scorers/d638bd93-5acc-45e9-a27b-1d1d6c54e0b5). Output ceilings differed because High consumed its reasoning budget before producing JSON: Low used 2,048 tokens, Medium 8,192, and High 32,768. None of the retained model calls reached its ceiling.

The following attempts are excluded:

- The first mutable playground execution launched 90 calls together and reached the organization's 200,000-token-per-minute limit.
- The first Medium and High immutable experiments ran at the same time and used a 2,048-token ceiling. Their capped rows and cross-level concurrency invalidate both accuracy and latency comparisons.
- A subsequent isolated High attempt still capped at 8,192 tokens and was deleted after the failure was confirmed.

Low `r1` completed 30 calls with no errors and is retained. Medium and High were then rerun strictly one experiment at a time with `max concurrency: 1`. Low was not rerun, so its latency was observed while the discarded experiments also existed; the quality scores are complete, but the first-round latency comparison remains preliminary.

High's retained experiment completed all 30 model calls with zero LLM errors and no token-cap failures. The custom scorer failed transiently on `qodo-ghost-1` and `qodo-ghost-2`; both valid JSON outputs were rescored successfully. Braintrust retains the two historical scorer errors in the experiment metrics even though all 30 rows now have all six scores.

### Retained first-round results

The links below point to immutable Braintrust experiments. Duration and token values are sums from the exported 30-row experiment data. Mean model time is `LLM duration / 30`.

| Effort | Experiment                                                                                                                                                    |     F1 | Functional recall | Impact recall | Overall recall | Precision | Model errors | Scorer errors | LLM duration | Mean model time | Completion tokens | Reasoning tokens |   Cost |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----------------: | ------------: | -------------: | --------: | -----------: | ------------: | -----------: | --------------: | ----------------: | ---------------: | -----: |
| Low    | [`low r1`](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/experiments/Codekeeper%20Qodo%20PR%20review%20low%20r1)                                     | 38.77% |            49.44% |        34.56% |         27.28% |    81.59% |            0 |             0 |      284.71s |           9.49s |            26,465 |           21,431 | $0.065 |
| Medium | [`medium isolated r1`](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/experiments/Codekeeper%20Qodo%20PR%20review%20medium%20isolated%20r1)           | 41.92% |            55.00% |        38.19% |         29.89% |    81.03% |            0 |             0 |      636.06s |          21.20s |            65,537 |           60,381 | $0.083 |
| High   | [`high isolated r1 retry`](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/experiments/Codekeeper%20Qodo%20PR%20review%20high%20isolated%20r1%20retry) | 43.38% |            58.33% |        40.61% |         31.93% |    82.28% |            0 |   2, rescored |    2,069.10s |          68.97s |           272,898 |          267,742 | $0.332 |

Medium is the selected Luna reasoning level for PR review. Relative to Low, it gains 5.56 percentage points of functional recall and 3.16 points of F1 while remaining above 81% precision, at 2.23 times the mean model latency. High gains only another 3.33 points of functional recall and 1.46 points of F1, but takes 3.25 times as long as Medium and costs 3.98 times as much. The repository and starter review policies now select GPT-5.6 Luna at Medium effort for both the review coordinator and read-only workspace specialist; other flows retain their existing assignments.

### Medium optimization result

The first improvement loop kept the model, effort, dataset, scorer, 8,192-token ceiling, and sequential execution fixed. It changed only the review strategy. The retained `v2` prompt requires four silent passes over every changed file and hunk: compile/contract, control/data flow, safety/lifecycle, and integration/platform behavior. A more elaborate semantic-delta `v3` prompt was worse and is retained as a rejected experiment rather than hidden.

| Medium prompt | Run | Functional recall | F1 | Precision | Impact recall | LLM duration | Mean model time | Errors |
| ------------- | --- | ----------------: | -: | --------: | ------------: | -----------: | --------------: | -----: |
| Baseline | `isolated r1` | 55.00% | 41.92% | 81.03% | 38.19% | 636.06s | 21.20s | 0 |
| Systematic `v2` | [`r1`](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/experiments/Codekeeper%20Luna%20Medium%20systematic%20v2%20r1) | 56.67% | 43.53% | 77.14% | 40.07% | 626.47s | 20.88s | 0 |
| Systematic `v2` | [`r2`](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/experiments/Codekeeper%20Luna%20Medium%20systematic%20v2%20r2) | 56.11% | 43.64% | 78.25% | 40.67% | 684.20s | 22.81s | 0 |
| Semantic delta `v3` | [`r1`, rejected](https://www.braintrust.dev/app/CodeKeeper/p/CodeKeeper/experiments/Codekeeper%20Luna%20Medium%20semantic%20delta%20v3%20r1) | 50.56% | 39.95% | 78.61% | 36.19% | 632.86s | 21.10s | 0 |

The systematic prompt's mean functional recall is 56.39%, 1.39 points above the baseline; mean F1 is 43.59%, 1.67 points higher. Precision falls by 3.34 points to 77.70%. This is a repeatable improvement, but not a large enough gain by itself.

Manual miss inspection also found that the benchmark is not a perfect product-quality oracle. Some zero-scored outputs reported plausible defects absent from the answer key, some correct root causes were anchored more than the scorer's three-line tolerance from a label, and `qodo-dify-6` contains overlapping or questionable rule labels. Those rows remain scored exactly as published. The scorer was not loosened to reward the model.

### Selective two-pass result

The strongest measured configuration keeps the baseline Medium pass for all 30 cases and routes a second systematic Medium pass only when `changedFiles >= 6` or `additions + deletions >= 400`. This selects 21 cases. Fusion retains the primary finding when both passes report the same file within six lines and adds only distinct secondary findings, capped at the existing 15-finding contract.

| Secondary run | Functional recall | F1 | Precision | Impact recall | Sequential model time | Mean per case |
| ------------- | ----------------: | -: | --------: | ------------: | --------------------: | ------------: |
| Systematic `v2 r1` | 60.00% | 44.47% | 79.37% | 41.76% | 1,080.61s | 36.02s |
| Systematic `v2 r2` | 60.56% | 45.64% | 83.81% | 42.40% | 1,115.13s | 37.17s |
| Two-run mean | 60.28% | 45.06% | 81.59% | 42.08% | — | 36.60s |

The best fused run exceeds High by 2.23 points of functional recall and 2.26 points of F1 while also exceeding High precision by 1.53 points. Its 37.17-second mean model time is 46.1% lower than High's 68.97 seconds. With the cached `v2 r2` export, baseline plus routed second-pass cost is `$0.150`; this is 54.7% below High's `$0.332`.

This fusion is an offline deterministic analysis of separate immutable Braintrust exports, not a single Braintrust multi-call experiment. The checked-in analyzer reproduces it from the exported baseline, secondary, and scorer files. Production adopts the measured single-pass improvements: Luna Medium plus the complete change-surface procedure. It does not use the benchmark's broad second-Medium-pass rule.

The escalation tier is Max rather than High. By explicit product decision, it ships without a separate Max evaluation. Before review, the frozen comparison routes both the coordinator and read-only workspace specialist to Luna Max when the PR already carries `security` or `risk high`, touches a configured security/high-risk path, changes at least 5,000 lines, or changes at least 1,000 lines in one file. A Medium workspace review may also make one focused Max follow-up, but only after emitting a validated blocking `high` or `critical` finding with `current` classification, `high` confidence, and a positive line in a frozen changed file. Overall risk, proposed labels, security phrasing, non-blocking findings, lower-confidence findings, and unlocated findings are explicitly insufficient. The focused Max result replaces the Medium result before coordination. High remains neither a production tier nor a proxy for Max. This routing is a product policy choice, not a measured claim that Max improves the Qodo scores above.

No live Codekeeper review runs were available when this path shipped, so there is no defensible end-to-end average latency yet. The immutable Qodo experiments measured a Medium model call at 20.88 to 22.81 seconds per case; that is not a GitHub workflow estimate and Max was not measured. Production now records every workspace pass and `totalModelDurationMs` so ordinary Medium, pre-routed Max, and Medium-to-Max reviews can be compared from actual runs without rerunning an evaluation.

## Interpret Braintrust traces

The Braintrust span captures the final coordinator input and response, including the authoritative Luna workspace result. It does not currently expose Luna's internal workspace tool-call spans. Use the trace to inspect evidence handoff, token use, latency, retries, and the structured final response; use the sealed artifact and GitHub run for end-to-end authority and publication evidence.

Review validation keeps a finding only when its file belongs to the pull-request diff. A model-supplied line outside that file's changed hunks is safely reduced to a file-level finding instead of discarding the complete review. This avoids guessing a replacement line while preserving the supported explanation and blocking decision.

One strong run is a smoke test. Three consistent runs across four independent defect categories are better evidence, but they still do not establish general reliability. Expand the suite with clean no-finding pull requests, missing-test cases, platform-specific behavior, large diffs, and intentionally misleading but non-defective changes.
