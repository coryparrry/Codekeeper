# Maintainability boundaries

Codekeeper keeps large existing modules from growing and rejects new oversized
implementation or test files. The check is repository-owned: reviewed ceilings
live in [`scripts/module-boundaries.json`](../scripts/module-boundaries.json)
and `npm run architecture:check` enforces them.

## Limits

| Kind | Line limit | Byte limit |
|---|---:|---:|
| New implementation module | 800 | 40,000 |
| New test file (`*.test.mjs`) | 1,000 | 60,000 |

A file already over those limits may stay only as a reviewed `legacy` entry.
Legacy files may shrink but cannot grow past the recorded line or byte ceiling.
Temporary exemptions exist only in that checked-in configuration.

The checker also fails closed for missing legacy files, duplicate inventory or
root entries, unsafe paths, and symlinks.

## Current exemptions

These ceilings were measured on this tree. They are not targets to grow into.

| File | Lines | Bytes |
|---|---:|---:|
| `acceptance/src/harness.mjs` | 1,455 | 83,761 |
| `packages/codekeeper/src/install.mjs` | 831 | 33,400 |
| `packages/codekeeper/src/plan.mjs` | 1,229 | 54,594 |
| `packages/codekeeper/src/preflight.mjs` | 1,472 | 63,835 |
| `packages/codekeeper/src/tui.mjs` | 948 | 36,271 |
| `packages/codekeeper/test/assets-plan.test.mjs` | 1,589 | 64,635 |
| `packages/codekeeper/test/cli.test.mjs` | 1,471 | 54,700 |
| `packages/codekeeper/test/tui.test.mjs` | 1,462 | 59,021 |
| `tools/codekeeper/src/lib/agents-runtime.mjs` | 1,143 | 49,648 |
| `tools/codekeeper/src/lib/git.mjs` | 884 | 32,028 |
| `tools/codekeeper/src/lib/github.mjs` | 1,177 | 48,406 |
| `tools/codekeeper/src/lib/publish.mjs` | 1,448 | 63,585 |
| `tools/codekeeper/test/agents-runtime.test.mjs` | 1,768 | 67,890 |
| `tools/codekeeper/test/commands.test.mjs` | 1,163 | 35,565 |
| `tools/codekeeper/test/integration.test.mjs` | 1,558 | 67,318 |
| `tools/codekeeper/test/publish.test.mjs` | 3,288 | 146,076 |
| `tools/codekeeper/test/workflow-contract.test.mjs` | 1,042 | 38,321 |

Remove a legacy entry only after the file is at or below the normal limit, or
after a behavior-preserving split has replaced it with bounded modules.

## Intended domain splits

Later behavior-preserving PRs should extract these domains without changing
public exports:

| Module | Intended split |
|---|---|
| `tools/codekeeper/src/lib/github.mjs` | transport, pagination, GraphQL, mutation guards, issues, pulls, comments, labels |
| `tools/codekeeper/src/lib/publish.mjs` | artifacts, review, issue, audit, fix, repair PR |
| `tools/codekeeper/src/lib/agents-runtime.mjs` | provider, tracing, cleanup, workspace, coordinator |
| `packages/codekeeper/src/preflight.mjs` | environment, repository, GitHub, installation, collisions, doctor |
| `packages/codekeeper/src/plan.mjs` | normalization, models, capabilities, policy, files, prompts, pull request |

Keep the original module path as a compatibility facade until every caller is
migrated. Do not combine a split with behavior, model, permission, or release
changes.

## Check

```bash
npm run architecture:check
```

The root `npm run check` command runs the same gate.
