# Architecture

AI Repo Maintainer is a source repository of reusable workflows. An adopter keeps the event trigger and policy in its own repository, then calls a reviewed source revision by full commit SHA. There is no shared database, webhook service, or hosted App.

```text
Adopter event and default-branch policy
        |
        v
Pinned reusable workflow revision
        |
        +-- analysis: OpenAI key, no GitHub App token
        |     - frozen policy and context
        |     - structured candidate artifact
        |
        +-- verification (repairs only): no credentials
        |     - fresh checkout and patch validation
        |
        +-- sealing: no credentials
        |     - immutable candidate and context hashes
        |
        +-- publication: short-lived adopter App token, no OpenAI key
              - labels, comments, issues, repair PRs, auto-merge
```

## Trust boundaries

The reusable workflow checks out its own revision with `job.workflow_repository` and `job.workflow_sha`. It reads the adopter policy only from the adopter default branch. The review caller is a default-branch `pull_request_target` definition that only invokes the reusable workflow; it never checks out or executes PR code. Pull request heads, issue data, comments, repository files, and model output are untrusted.

The workflow puts its frozen context directly in the model prompt. It does not rely on a context file inside the model checkout. Candidate artifacts contain the context, result, validation record, and optional patch; a later credential-free job validates repair patches again in a fresh checkout. A final job mints the adopter GitHub App token and publishes only the sealed artifact. It does not execute adopter repository code.

Labels and sticky comments are owned only when both their marker and configured App bot identity match. Maintenance fingerprints and repair-PR markers use the same identity check, avoiding a separate state store.

## Review gate and auto-merge

The reusable review workflow exposes a PR-native, fail-closed gate after publication. It passes only after analysis, sealing, and publication succeed for the supported PR shape. It is not an external commit-status publisher.

Auto-merge is separately evaluated from the model recommendation. It requires an allowed author or automation branch, same-repository open non-draft PR, low risk, adequate tests, no blocking findings, and the configured file, line, and path limits. A later ineligible review attempts to remove stale auto-merge.

## Supported shape

This design is GitHub.com-only because it depends on reusable-workflow identity fields not available on GitHub Enterprise Server. The review gate supports only non-draft, same-repository PRs aimed at the repository default branch. Forks, drafts, disabled runs, and non-default targets fail closed. The supplied caller does not trigger `merge_group`, so its gate must not be required for merge queues.

Issue triage and fixes are intentionally configured-owner-command-only. Their comment triggers require an eligible caller association, and the frozen policy independently requires the triggering GitHub login in `repository.ownerLogins`; manual fixes use the same policy check. These limits keep the reusable workflow small and avoid a public-event privilege boundary.
