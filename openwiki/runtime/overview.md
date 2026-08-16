---
type: runtime-reference
title: Runtime CLI and phase surface
description: Public runtime commands, phase ownership, inputs, outputs, and side effects.
tags: [runtime, cli, api]
---

# Runtime CLI and phase surface

`tools/codekeeper/src/cli.mjs` is the runtime entrypoint. It accepts strict command-specific flags, uses runner-owned paths, and dispatches preparation, agent execution, validation, sealing, verification, and publication. Public commands are `check-config`, `owner-command`, `agent-settings`, `prepare-review`, `prepare-audit`, `prepare-issue`, `prepare-fix`, `run-workspace-agent`, `run-agent`, `capture-workspace-patch`, `apply-workspace-patch`, `validate-*`, `seal-*`, `verify-audit`, `verify-fix`, and `publish-*`.

Preparation reads event/configuration and writes a frozen context bundle. Agent commands read that bundle and write structured results. Validation reads context plus results and writes a candidate; sealing binds hashes and permissions. Publication reads only a sealed candidate and performs GitHub mutations. Patch commands are bounded and require explicit workspace paths and validation policy.

Inputs include event JSON, policy, package/tooling digest, profile bundle, runner environment, and command flags. Outputs are JSON artifacts with explicit hashes and mode-specific schemas from `schemas.mjs`; failures are non-zero and fail closed. Runtime commands do not expose a general public library API: the CLI and artifact formats are the compatibility surface.

See [execution](execution.md), [validation/publication](validation-publication.md), and [configuration](../architecture/configuration.md). Focused tests are `tools/codekeeper/test/cli.test.mjs`, `config.test.mjs`, workflow contract tests, and runtime audit command tests. Run `cd tools/codekeeper && npm run check` or a targeted `node --test test/<suite>.test.mjs`.
