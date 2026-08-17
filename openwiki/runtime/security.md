---
type: security-model
title: Runtime security model
description: Credential separation, untrusted input boundaries, workspace controls, and fail-closed publication rules.
tags: [security, trust-boundary, runtime]
---

# Runtime security model

Provider keys are analysis-only, Codex keys are workspace-only, trace keys are tracing-only, and the GitHub App token exists only in publication. The review caller is a default-branch `pull_request_target` workflow that does not execute PR code. Event fields, issue text, comments, diffs, repository files, specialist output, and model output are untrusted data.

`process-supervisor.mjs` bounds validation commands and kills process groups after deadline/grace periods. Workspace runs use fresh runner-owned homes and quarantine repository skills. `git.mjs` bounds diffs, patches, changed files, and output. `validate.mjs` validates and seals before any credentialed job. `publish.mjs` checks managed markers and App identity before conditional mutations.

The installer separately hardens its local boundary: `command-runner.mjs` resolves trusted absolute `git`, `gh`, and `npm` paths and rejects checkout-local shadows; `input-safety.mjs` and `private-key-input.mjs` validate PEM metadata and pass key bytes through child stdin/file descriptors only; `install.mjs` rejects traversal, symlinked parents, and unsafe target collisions. Command output is bounded/redacted and secrets are not forwarded to child environments. The supported isolation boundary is a GitHub-hosted runner, not a hostile self-hosted runner. GitHub Enterprise Server, forks, drafts, stale heads, protected branches, and unsupported targets fail closed. Security evidence lives in runtime audit suites, workflow authorization tests, installer trust tests, and acceptance boundary scenarios. Never add credentials, tokens, private keys, or `.env` material to this wiki.
