# Repository security checks

Codekeeper keeps security analysis in repository-owned, reviewable workflows.
The checks complement—not replace—private vulnerability reporting, branch
rules, normal tests, and maintainer review.

## Pull requests

- **Dependency Review** rejects newly introduced dependencies with high or
  critical known vulnerabilities and applies the tracked license deny-list.
- **CodeQL** analyzes JavaScript and workflow-adjacent source and uploads its
  results to GitHub code scanning.
- Existing Codekeeper source, runtime, installer, workflow, and acceptance
  checks remain independently required by repository governance.

## Push and scheduled evidence

The weekly and default-branch security workflow:

1. runs CodeQL;
2. audits production dependency graphs in the root, runtime, and installer
   lockfiles;
3. creates a deterministic SPDX 2.3 SBOM from those exact lockfiles;
4. evaluates the tracked license policy; and
5. retains the SBOM and bounded license report as a workflow artifact.

Missing package license metadata is reported rather than treated as a license
approval. A package matching the deny-list fails the workflow.

## Repository settings that source cannot enable

The tracked workflow cannot switch on GitHub repository security settings.
Before Codekeeper becomes public or publishes a package, an administrator must
enable and prove:

- private vulnerability reporting;
- secret scanning;
- secret-scanning push protection;
- code scanning availability for the repository; and
- dependency graph and Dependabot alerts.

Record the repository setting evidence, exact commit, and workflow run in the
release-readiness evidence index. Do not infer that a tracked workflow means a
GitHub-side feature is enabled.

## Generated evidence

`codekeeper.spdx.json` is deterministic for one set of lockfiles and
`SOURCE_DATE_EPOCH`. `license-report.json` contains package counts, denied
matches, and packages whose npm lock metadata does not declare a license. It
contains no provider credentials, App keys, tokens, or live traces.
