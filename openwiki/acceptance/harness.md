---
type: acceptance-harness
title: Deterministic acceptance harness
description: Offline fixture, workflow scenario mapping, evidence capture, and boundary assertions.
tags: [acceptance, harness, testing]
---

# Deterministic acceptance harness

`acceptance/src/harness.mjs` runs Codekeeper against a controlled fixture and simulates workflow events, jobs, GitHub state, package acquisition, and model outcomes without live GitHub or provider calls. `evidence.mjs` records assertions and externally visible results. `acceptance/bin/` supplies executable entrypoints; `acceptance/fixture/` supplies the representative adopter repository.

Scenarios map event type and caller to review, maintain, issues, fix, and assistant workflows. The harness exercises authorization, package/bootstrap integrity, fail-closed gates, marker/idempotency behavior, repair paths, timeout and process cleanup, partial mutation, rollback, and recovery. This is the public behavioral contract for cross-system flows; unit tests remain the canonical evidence for individual symbols.

Run `cd acceptance && npm run check`. Keep scenarios deterministic and offline; live provider evaluations belong to `tools/codekeeper/evals/` and are conditional, not acceptance prerequisites.
