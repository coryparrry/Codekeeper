---
type: testing-guide
title: Testing and validation layers
description: Focused contracts, security audits, package checks, workflow tests, acceptance, and evaluation boundaries.
tags: [testing, validation, acceptance]
---

# Testing and validation layers

Runtime unit/contract suites cover config, schemas, agents, Git, GitHub, publication, workflows, and tooling artifacts. Security audit suites under `tools/codekeeper/audit/` target command authorization, Git boundaries, pagination, publication, runtime, workflow boundaries, and untracked capture. Installer tests cover trust, acquisition, staging, PEM input, rollback, update, TUI, and runtime installation. Acceptance is deterministic and offline, using `acceptance/src/harness.mjs` and a fixture repository.

Failure evidence is intentional: tests assert fail-closed unsupported events, stale heads, path collisions, invalid manifests, hidden paths, timeouts, process cleanup, patch limits, rollback, partial mutation, and marker ownership. Acceptance harness scenarios map events to caller/workflow jobs and verify externally visible GitHub-style state without live credentials.

Commands:

```bash
npm run check
cd tools/codekeeper && npm run check
cd packages/codekeeper && npm run check
cd acceptance && npm run check
```

Use targeted `node --test` suites for narrow changes. Production acceptance requires Node 22+, locked package/runtime dependencies, package-stage and source-release verification, and evidence for each scenario: fresh setup must produce the expected managed files and startup settings; rerun must preserve adopter profile overrides and avoid unnecessary App/secret prompts; settings-only update must change callers/policy without a release payload; release update must verify receipt, manifest, and retired artifacts; disabled installation must omit execution paths and credentials; failed/partial operations must expose a resumable error and leave no unsafe unowned mutation. Offline evaluations are separate from correctness checks; live provider evaluations require credentials and are not required for ordinary changes. Release and workflow checks additionally verify YAML/actionlint, manifests, package staging, and clean source inventory.
