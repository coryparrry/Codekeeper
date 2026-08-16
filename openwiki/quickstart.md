---
type: quickstart
title: Codekeeper wiki quickstart
description: Navigation and task routing for understanding and safely changing the Codekeeper repository.
tags: [quickstart, navigation, codekeeper]
---

# Codekeeper wiki quickstart

Codekeeper is a versioned GitHub Actions workflow system for one adopter repository. It has an installer/package plane, a runtime plane, generated workflow callers, and a deterministic acceptance harness. Start with [architecture](architecture/overview.md), then choose the change route below.

## Major concepts

- [Configuration and policy](architecture/configuration.md): `.github/codekeeper.json`, settings precedence, profiles, credentials, and frozen hashes.
- [Runtime CLI](runtime/overview.md): commands, phase boundaries, artifacts, and result contracts.
- [Runtime execution](runtime/execution.md): preparation, specialist/coordinator separation, profiles, presets, and bootstrap.
- [Validation and publication](runtime/validation-publication.md): schemas, sealing, repairs, markers, leases, and GitHub mutations.
- [Runtime security](runtime/security.md): credentials, untrusted input, process/workspace limits, and fail-closed rules.
- [Installer](installer/overview.md): CLI/TUI, preflight, plans, setup/update, credentials, and rollback.
- [Release integrity](installer/artifacts-and-releases.md): source, package, tooling manifest, assets, and workflow verification chain.
- [Workflow modes](workflows/overview.md): review, maintain, issues, fix, assistant, permissions, artifacts, and reruns.
- [Testing](operations/testing.md): focused contracts, audits, package/release checks, and acceptance evidence.
- [Operations runbook](operations/runbook.md): safe installation, update, recovery, secrets, markers, and partial failure.
- [Acceptance harness](acceptance/harness.md): offline fixture scenarios and cross-system behavior.

## Task routing

| Intent | Canonical page | Source entrypoints/symbols | Focused validation |
|---|---|---|---|
| Change runtime preparation or agent behavior | [Runtime execution](runtime/execution.md) | `tools/codekeeper/src/cli.mjs`, `prepare.mjs`, `agents-runtime.mjs` | Runtime agent/config tests |
| Change validation, repair, or GitHub mutation | [Validation/publication](runtime/validation-publication.md) | `validate.mjs`, `publish.mjs`, `git.mjs`, `github.mjs` | Publication, Git-validation, authorization tests |
| Change policy, providers, capabilities, or profiles | [Configuration](architecture/configuration.md) | `policy-validator.mjs`, `config.mjs`, `agent-profiles.mjs` | Policy/config/workflow tests; `check-config` |
| Change installer setup or update | [Installer](installer/overview.md) | package `cli.mjs`, `install.mjs`, `plan.mjs`, `updater.mjs` | Package installer/updater tests |
| Change package contents or release verification | [Release integrity](installer/artifacts-and-releases.md) | build/pack scripts, `release-verifier.mjs`, `action.yml` | package-stage/contract and source-release checks |
| Change event triggers or job choreography | [Workflow modes](workflows/overview.md) | `.github/workflows/codekeeper-*.yml`, packaged workflow assets | workflow contract/authorization and acceptance tests |
| Diagnose a failed install or runtime run | [Operations runbook](operations/runbook.md) | `install.mjs`, `publish.mjs`, markers and error formatting | targeted failure test, then full check |
| Add or revise cross-system behavior | [Acceptance harness](acceptance/harness.md) | `acceptance/src/harness.mjs`, `evidence.mjs` | `cd acceptance && npm run check` |

## Validation baseline

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
node tools/codekeeper/src/cli.mjs check-config
cd tools/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
cd ../.. && cd packages/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
cd ../.. && cd acceptance && npm run check
```

Use the narrowest focused suite first, then the package/runtime/acceptance checks for cross-plane changes. Do not document or commit secrets, credentials, private keys, or `.env` files. Generated package/workflow/manifests must be regenerated from their source owners.
