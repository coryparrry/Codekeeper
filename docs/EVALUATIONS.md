# Evaluating Rivet reviews

Rivet packages four stable agent identities under `assets/agents/`. Review,
repair, and incoming issue triage consume the reviewer, fixer, and
issue-triager identities. The repository-auditor remains a versioned contract
asset until its workflow ships. Embedded versions and raw SHA-256 digests are
contract-tested so evaluation results stay bound to the identity that produced
them.

The live review evaluator grades complete gh-aw safe-output artifacts. It does
not call a model, publish GitHub output, or replace live adopter testing.

## Build a controlled suite

Use a disposable adopter repository and create a pull request with one
deterministic defect. Keep its answer key outside the repository and do not
name the defect or expected file in the pull-request title or body. Retain the
exact head SHA and repeat the same immutable head when measuring consistency.

For every run, collect these files into one directory:

```text
runs/
  001/
    run.json
    aw-prompts/prompt.txt
    agent_output.json
    safe-output-items.jsonl
```

`run.json` binds the downloaded artifact to the GitHub run:

```json
{
  "runId": 3187,
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "conclusion": "success"
}
```

`agent_output.json` is the agent's semantic output. The evaluator rejects any
agent error, then matches each
expected inline comment by repository-relative path, exact line, and required
case-insensitive body terms. Unmatched comments are false positives.
`safe-output-items.jsonl` is publication evidence; every mutating output must
have exactly one receipt of the same type.

## Write the answer key

Copy the packaged `pr-reviewer.md` beside the manifest without editing it, then
record its exact SHA-256:

```json
{
  "version": 1,
  "repeat": 3,
  "expectedHeadSha": "0123456789abcdef0123456789abcdef01234567",
  "reviewerProfile": {
    "path": "./pr-reviewer.md",
    "sha256": "0a5fbe580ffe777c58655ac31f2491438e1fd2d4fc5763b598c93097c7d01581"
  },
  "expected": {
    "terminal": "review",
    "comments": [
      {
        "path": "src/discount.mjs",
        "line": 2,
        "bodyIncludes": ["above 100", "negative totals"]
      }
    ],
    "submitReviewEvent": "COMMENT",
    "createIssueCount": 0
  }
}
```

Set `terminal` to `noop` or `report_incomplete` only when that is the expected
result; both require an empty comment list, a null review event, and zero issue
creation.

## Run the evaluator

From this repository:

```bash
cd packages/rivet
npm run eval:live-review -- \
  --manifest /secure/local/manifest.json \
  --runs-directory /secure/local/runs
```

Against the published package:

```bash
npx --package=@coryparry/rivet rivet-review-eval \
  --manifest /secure/local/manifest.json \
  --runs-directory /secure/local/runs
```

The command writes one JSON report to standard output and exits nonzero when a
run has the wrong head, omits or changes the reviewer identity, misses an
expected finding, produces a false positive, submits the wrong review event,
or lacks a matching publication receipt.

Keep live workflow evidence separate from this score: workflow URL, App
identity, exact commit, job conclusions, and resulting GitHub review or issue.
A local evaluator pass does not prove provider availability, GitHub authority,
or successful publication.
