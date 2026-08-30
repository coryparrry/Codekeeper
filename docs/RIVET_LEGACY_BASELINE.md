# Rivet migration legacy baseline

This baseline freezes the source state that the gh-aw migration must replace
without silently dropping supported behavior. It is evidence for the migration
contract, not a claim that every listed boundary has been rerun live.

## Source checkpoint

| Field                                                    | Value                                      |
| -------------------------------------------------------- | ------------------------------------------ |
| Commit                                                   | `223213f401955300da209fd06de2580191ec2ddb` |
| Release tag                                              | `codekeeper-v0.5.3`                        |
| Default branch                                           | `main`                                     |
| Runtime and installer language                           | Node.js 22+ ES modules                     |
| Tracked runtime module lines                             | 42,943 under `tools/codekeeper/`           |
| Tracked installer module lines                           | 31,879 under `packages/codekeeper/`        |
| Runtime test declarations                                | 494                                        |
| Installer test declarations                              | 366                                        |
| Offline acceptance declarations                          | 32                                         |
| Combined runtime, installer, and acceptance module lines | 73,907                                     |

Line and test counts are repository measurements at the checkpoint. They are
comparison signals, not test results.

## Supported product modes

| Mode                | Current behavior to preserve or explicitly retire                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| Pull request review | Automatic and owner-command review, inline findings, sticky state, fail-closed gate, optional bounded repair    |
| Issue triage        | Automatic/manual triage, duplicate handling, readiness reporting, optional separately authorized implementation |
| Maintenance         | Repository audit, report-only default, optional repair PR                                                       |
| Fix                 | Owner-authorized repair with validation and protected-path controls                                             |
| Assistant           | Owner command routing into supported maintenance operations                                                     |

Merge authority is a separate capability and must remain disabled throughout
the migration until explicitly reconsidered after repair parity.

## Current capability controls

- automatic review repair;
- repository maintenance repair;
- issue implementation;
- exact-duplicate closure;
- automatic merge;
- provider/model assignment by role;
- validation commands and protected paths;
- owner-login and App-identity authorization;
- optional adopter-owned agent profile overrides;
- review reasoning escalation;
- generated caller, package receipt, and release-ledger verification.

## Provider baseline

| Provider route | Current installer support                       | Migration requirement                                                               |
| -------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| OpenAI         | Responses-compatible models and Codex workspace | Prove supported gh-aw Codex/engine route and report model differences               |
| DeepSeek       | Chat-completions-compatible V4 presets          | Use a reliable upstream custom endpoint/engine path or report unsupported migration |
| OpenRouter     | OpenAI-compatible custom endpoint preset        | Use an upstream custom endpoint/engine path or report unsupported migration         |

Claude, Copilot, and Gemini belong in the gh-aw compatibility matrix even
though they are not current installer presets. Provider parity must not recreate
the generic provider SDK being removed.

## Current execution and trust shape

- Review uses a fresh analysis runner and a separate trusted gate runner.
- Audit, issue, and fix modes use staged compute, credential-free validation,
  sealing, and credentialed publication boundaries.
- The App private key is absent from model and PR-code execution.
- Policy and optional agent overrides are read from the trusted default branch.
- Package acquisition is exact-version and SHA-512 bound, followed by inventory
  and source-checkpoint verification.
- Repair publication is bound to the reviewed head and followed by re-review.
- Generated callers and reusable workflows remain repository owned.

The gh-aw replacement may simplify this topology, but it must prove equivalent
authority and credential boundaries rather than preserve runner count for its
own sake.

## Frozen evaluation categories

Migration fixtures must continue to cover:

- clean pull requests that require no publication action;
- blocking correctness, security, and missing-test findings;
- prompt/policy edits from an untrusted pull request;
- owner authorization, unauthorized actors, replay, and stale heads;
- validation failure and ambiguous or partial repair;
- re-review states: resolved, unresolved, regressed, and new;
- duplicate events, reruns, retries, timeouts, and cancellation;
- protected and unrelated paths;
- no-patch issue and maintenance results;
- package, workflow, App identity, and authority drift.

## Baseline evidence gaps

The source checkpoint and repository counts were verified locally when this
document was created. Current GitHub Actions duration, runner usage, cost, live
App installation, provider quality, and adopter behavior were not refreshed
because GitHub CLI authentication was unavailable. Those are open evidence
gaps, not passes or product failures.

Before the review-only cutover, capture controlled legacy and Rivet runs for the
same frozen fixtures and record exact workflow, package, App, repository, and
head identities.
