# Private acceptance harness

This package is a dependency-free Node 22+ harness for a deliberately named, pre-existing **private** GitHub.com fixture repository. It is not a repository creator, installer, credential manager, cleanup tool, or production service. It never reads secret values and never invokes `gh secret set`, `gh variable set`, repository creation/deletion, App creation, or credential configuration.

The harness has one read-only command and four explicitly acknowledged scenarios:

| Command | Purpose | Trigger ownership |
|---|---|---|
| `preflight` | Verify GitHub.com authentication, explicit private target, and fixture naming. | Read-only |
| `maintenance-dry-run` | Dispatch the adopter's maintenance workflow with `dry_run=true`; require a successful run and skipped publication. | Harness |
| `review-introduced-defect` | Verify the run for a manually opened same-repository defect PR. | GitHub PR event |
| `issue-triage-related` | Verify the run for a manually opened related, non-duplicate issue. | GitHub issue event |
| `controlled-fix` | Dispatch a configured low-risk fix for an existing issue and verify the bounded open PR. | Harness |

## Manual prerequisites

Before any scenario command, a maintainer must manually prepare an existing private repository whose name begins `codekeeper-acceptance-`. Seed it from [`fixture/`](fixture), configure it as a Codekeeper adopter using the normal pinned workflow templates and policy, and configure an App, names-only variables, and secrets through the normal GitHub UI or approved operational process. The harness neither creates nor reads any of those credentials.

Use the fixture policy to keep fixes low-risk: set `issues.allowAiImplementation=true`; permit **exactly** `src/discount.mjs` and `test/discount.test.mjs` in `audit.repair.allowedPaths`; configure `node --test test/*.test.mjs` as the fixture validation command; keep auto-merge disabled; and retain a slash-terminated automation prefix. The harness validates those policy preconditions before dispatch and later observes the Codekeeper implementation-verification job; no workflow log or test output is captured. Keep the fixture free of prior open PRs on that automation prefix, because the harness refuses an ambiguous candidate rather than cleaning one up.

Create the review PR and issue manually in the target fixture repository. The review PR must be open, non-draft, same-repository, target the repository default branch, and contain a deliberately introduced defect. The issue must be genuinely related to the fixture but not a duplicate. Use the supplied review and issue caller templates unchanged: their deterministic run names bind review evidence to both the PR number and current head SHA, and issue evidence to the issue number. Codekeeper's current App-owned review and issue comments also include the exact GitHub Actions run URL, which the harness requires; an old marker comment or a marker from another run cannot satisfy the check. After their GitHub event workflows start, obtain each exact run ID through GitHub's UI; the harness does not infer an issue run from an unrelated latest run. Also record the configured App bot's REST/UI login ending in `[bot]` and immutable numeric GitHub bot ID. GitHub GraphQL omits the `[bot]` suffix for the same Bot object, so the harness canonicalizes only that suffix while still requiring the exact numeric ID; an old comment from a similarly named actor cannot pass.

Store evidence outside the local checkout of that target fixture repository. The evidence parent directory must already exist, have no symbolic-link components, and be outside the fixture checkout; the harness refuses to create it. The command canonicalizes both locations before writing and rechecks them immediately before the atomic no-overwrite write. Evidence is a permission-restricted JSON file containing only the target, scenario, supplied source SHA, bounded immutable dispatch tag when applicable, run metadata, issue/PR identifier, assertions, result, and timestamps.

## Commands

Read-only preflight:

```sh
node bin/codekeeper-acceptance.mjs preflight --repo OWNER/codekeeper-acceptance-NAME
```

Every scenario requires its exact immutable Codekeeper source commit, an explicit acknowledgement, an existing local fixture checkout, and a fresh JSON evidence path outside that checkout:

```sh
node bin/codekeeper-acceptance.mjs maintenance-dry-run \
  --repo OWNER/codekeeper-acceptance-NAME \
  --source-sha 0123456789abcdef0123456789abcdef01234567 \
  --acknowledge-private-acceptance \
  --fixture-checkout /absolute/path/to/codekeeper-acceptance-NAME \
  --evidence /absolute/path/to/private-evidence/maintenance.json
```

```sh
node bin/codekeeper-acceptance.mjs review-introduced-defect \
  --repo OWNER/codekeeper-acceptance-NAME \
  --source-sha 0123456789abcdef0123456789abcdef01234567 \
  --acknowledge-private-acceptance \
  --fixture-checkout /absolute/path/to/codekeeper-acceptance-NAME \
  --evidence /absolute/path/to/private-evidence/review.json \
  --pr 12 --run-id 345678 --app-login codekeeper-acceptance[bot] --app-id 123456
```

```sh
node bin/codekeeper-acceptance.mjs issue-triage-related \
  --repo OWNER/codekeeper-acceptance-NAME \
  --source-sha 0123456789abcdef0123456789abcdef01234567 \
  --acknowledge-private-acceptance \
  --fixture-checkout /absolute/path/to/codekeeper-acceptance-NAME \
  --evidence /absolute/path/to/private-evidence/issue.json \
  --issue 13 --run-id 345679 --app-login codekeeper-acceptance[bot] --app-id 123456
```

```sh
node bin/codekeeper-acceptance.mjs controlled-fix \
  --repo OWNER/codekeeper-acceptance-NAME \
  --source-sha 0123456789abcdef0123456789abcdef01234567 \
  --acknowledge-private-acceptance \
  --fixture-checkout /absolute/path/to/codekeeper-acceptance-NAME \
  --evidence /absolute/path/to/private-evidence/fix.json \
  --issue 14 --app-login codekeeper-acceptance[bot] --app-id 123456
```

No scenario accepts a branch or tag in place of `--source-sha`. Each caller must have exactly two active Codekeeper source pins in the supported job shape: `jobs.bootstrap.steps[*].uses` for the direct `tools/codekeeper` action and `jobs.<scenario-job>.uses` for the matching reusable workflow (`maintain`, `fix`, `review`, or `triage`). The expected bootstrap job, its exact action step, and the scenario reusable job must not have an `if` gate; the scenario job must contain exactly the literal scalar `needs: bootstrap`. Block scalars, anchors, aliases, expressions, nested or misplaced `uses`, duplicate jobs, ref names, mismatches, and extra active `uses` entries fail closed, so another action cannot substitute for either required pin. The `tools/codekeeper` and `.github/workflows/codekeeper-*.yml` path components are case-sensitive; GitHub repository owner/name and hexadecimal SHA comparisons are normalized case-insensitively because GitHub repository identity and commit identifiers are case-insensitive. For maintenance and controlled fixes, after preflight the harness resolves the default-branch SHA and prevalidates those paired caller pins (and fix policy) at that exact SHA before creating any tag. It then creates one unique retained `codekeeper-acceptance/dispatch-...` tag, verifies it, re-reads those inputs through both the tag and SHA, and dispatches with that tag as `--ref`. It never deletes the tag: the retained ref is bounded evidence for the later run. It revalidates every baseline workflow after every polling list and again after selected-run completion; it refuses overlapping or rerun baselines, ambiguous new runs, old automation-prefix PRs, or missing exact-run App publication evidence. Event scenarios read the caller at the actual run head SHA. New dispatch discovery remains bounded to 20 checks at three-second intervals. Once the exact uniquely attributed run is selected, completion is polled every five seconds for at most ten minutes (121 checks, including the initial check), which accommodates the observed three-minute specialist workflow while remaining fail-closed. Every `gh` command has its own deadline with process termination escalation. It does not retain workflow logs, comments, diffs, model prompts, or provider output, and operational failures are reported generically rather than echoing `gh` output.

## Exact offline checks

These commands do not call GitHub, `gh`, providers, or any paid service:

```sh
node --test test/*.test.mjs
node --check bin/codekeeper-acceptance.mjs
node --check src/evidence.mjs
node --check src/harness.mjs
node --test fixture/test/*.test.mjs
npm run check
```
