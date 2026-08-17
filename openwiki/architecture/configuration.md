---
type: configuration
title: Configuration and policy
description: Runtime policy, installer settings, profiles, precedence, and frozen values across Codekeeper planes.
tags: [configuration, policy, security]
---

# Configuration and policy

`.github/codekeeper.json` is the versioned runtime policy, validated by `tools/codekeeper/src/lib/policy-validator.mjs`. It defines repository identity, owner authorization, automation switches, providers, four agent modes, labels, validation, repair, and auto-merge. `config.mjs` loads it, derives mode settings, and applies thresholds such as paths, labels, and change size.

Configuration planes are separate: installer settings belong to `packages/codekeeper/src/settings.mjs`; runtime policy belongs to the adopter default branch; workflow inputs and environment provide event/package/credential context; packaged agent profiles and optional adopter overrides provide coordinator instructions. On rerun, `settings.mjs` validates editable settings, `plan.mjs` derives required and existing secret names from selected modes/providers/workspaces/tracing: provider keys are requested only for selected model modes, workspace/Codex keys only when workspace is enabled, trace keys only when tracing is enabled, and the App credential only when mutation-capable workflows require it. `buildInstallPlan` distinguishes settings/configuration-only updates from release updates. Configuration-only plans rewrite generated policy/callers while preserving adopter-owned profile overrides and avoid an unnecessary release PR; release plans update package-owned assets and retire only catalogued prior artifacts. CLI flags select a command and bounded overrides, but cannot bypass policy validation or trust checks. Secrets are environment inputs only and are never serialized into wiki or model evidence.

Preparation snapshots policy, profile provenance, tooling/package identity, event context, and relevant GitHub state. Validation and sealing bind those values by hash; publication rejects stale or mismatched snapshots. A change that crosses planes must update the owning validator, generated/package copy, workflow contract, and focused tests.

Tests: runtime `config`, `policy`, schema, workflow authorization, and tooling-artifact suites; installer preflight/settings tests; package-stage checks. Run `node tools/codekeeper/src/cli.mjs check-config` for the current repository policy, then the relevant package/runtime checks.
