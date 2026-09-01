# Evaluating Rivet reviews

Rivet packages four stable agent identities under `assets/agents/`. Review,
repair, incoming issue triage, and report-only maintenance consume the
reviewer, fixer, issue-triager, and repository-auditor identities. Embedded
versions and raw SHA-256 digests are contract-tested so evaluation results stay
bound to the identity that produced them.

The live review evaluator grades complete gh-aw safe-output artifacts. It does
not call a model, publish GitHub output, or replace live adopter testing.

## Evaluate report-only maintenance

The maintenance evaluator grades a completed, validated JSON audit artifact and
its receipt. It binds both the evaluated head and the fetched default-branch
SHA, requires the exact `repository-auditor.md` bytes in the prompt, and rejects
GitHub mutations, credentials, and security-sensitive findings. A report with
an explicit `incomplete` status is scored as incomplete rather than as a clean
audit.

Keep the answer key and profile outside the adopter repository. Copy the
packaged `repository-auditor.md` byte-for-byte and record its SHA-256:

```json
{
  "version": 1,
  "repeat": 3,
  "expectedRepository": "owner/repository",
  "expectedHeadSha": "0123456789abcdef0123456789abcdef01234567",
  "expectedDefaultBranchSha": "0123456789abcdef0123456789abcdef01234567",
  "expectedSourceRef": "refs/heads/main",
  "auditorProfile": {
    "path": "./repository-auditor.md",
    "sha256": "5b1b7f8fc57b68e33ada30ea926a22f3b41a486288dc676ada0850c6ba7f9197"
  },
  "expected": {
    "terminal": "complete",
    "findingIds": []
  }
}
```

Each complete run directory contains `run.json`, `aw-prompts/prompt.txt`,
`agent_output.json`, `audit.json`, `receipt.json`, and one `validate_audit` item
in `safe-output-items.jsonl`. The artifact contains `schemaVersion`, `headSha`,
`sourceRef`, `summary`, `findings`, `validatedAt`, and `expiresAt`; each finding
uses `id`, `path`, `problemKey`, `title`, `category`, `priority`, `evidence`,
and `recommendation`.
The receipt contains the repository, head, source ref, validation and expiry
timestamps, and the SHA-256 of the exact artifact bytes. An incomplete run
contains no `audit.json` or `receipt.json` and instead has one
`report_incomplete` item.

```bash
cd packages/rivet
npm run eval:live-audit -- \
  --manifest /secure/local/manifest.json \
  --runs-directory /secure/local/runs
```

Run the installed workflow manually or use its weekly schedule to collect the
artifact. Maintenance creates no issue, pull request, comment, commit, label,
or merge; the evaluator does not prove provider availability or GitHub
authority.

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
Every complete review also requires the Rivet summary sections for the change,
merge readiness, verification, before-merge work, and collapsed review details.
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

Use `terminal: "review"` for every complete comparison, including clean reviews
with an empty comment list. `noop` remains available only for grading historical
runs. Use `report_incomplete` when the comparison boundary is unavailable; both
non-review outcomes require an empty comment list, a null review event, and zero
issue creation.

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
For review outcomes it also fails when the submitted body omits the required
general-review structure.

Keep live workflow evidence separate from this score: workflow URL, App
identity, exact commit, job conclusions, and resulting GitHub review or issue.
A local evaluator pass does not prove provider availability, GitHub authority,
or successful publication.
