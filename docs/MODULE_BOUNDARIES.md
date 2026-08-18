# Module boundary ratchet

Codekeeper has five implementation modules that predate the current
maintainability target and remain larger than a focused coding agent should need
to read for one task:

| Module | Current ceiling | Intended split |
|---|---:|---|
| `tools/codekeeper/src/lib/publish.mjs` | 63,585 bytes | artifact loading, review publication, issue publication, audit publication, fix publication, reconciliation |
| `tools/codekeeper/src/lib/github-core.mjs` | 61,928 bytes | transport, pagination, GraphQL, mutation guards, issues, pulls, comments, labels |
| `tools/codekeeper/src/lib/agents-runtime.mjs` | 49,648 bytes | provider clients, workspace specialist, coordinator, tracing, attempt policy |
| `packages/codekeeper/src/preflight.mjs` | 63,835 bytes | local Git, GitHub repository, App authority, collision detection, doctor reporting |
| `packages/codekeeper/src/plan.mjs` | 54,594 bytes | answers, policy rendering, workflow rendering, permissions, settings, files |

This PR does not pretend those modules were safely split in one mechanical
change. It adds an enforceable ratchet:

- legacy modules may shrink but cannot grow past their reviewed byte ceilings;
- every new `.mjs` implementation module in the runtime and installer roots is
  limited to 800 lines and 40,000 bytes;
- symlinks, missing legacy modules, unsafe paths, duplicate inventory, and
  malformed limits fail closed;
- removing a module from the legacy list is allowed only after its replacement
  modules satisfy the normal limits.

## Refactor sequence

Each split should be a behavior-preserving PR with existing tests green before
and after:

1. extract pure data normalization and rendering helpers;
2. move endpoint- or mode-specific operations behind narrow exports;
3. update only the callers for that domain;
4. retain mutation guards and credential boundaries in their current jobs;
5. regenerate tooling and source inventories;
6. remove the old legacy ceiling only when no oversized implementation remains.

Do not combine a module split with behavior changes, model changes, workflow
permission changes, or release publication.
