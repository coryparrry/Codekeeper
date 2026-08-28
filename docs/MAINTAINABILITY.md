# Maintainability boundaries

Codekeeper keeps large existing modules from growing and rejects new oversized
implementation or test files. Compatibility facades re-export the original
public paths. Domain modules must not import back through those facades.
Reviewed ceilings live in
[`scripts/module-boundaries.json`](../scripts/module-boundaries.json) and
`npm run architecture:check` enforces size limits and the local-import graph.

## Limits

| Kind | Line limit | Byte limit |
|---|---:|---:|
| New implementation module | 800 | 40,000 |
| New test file (`*.test.mjs`) | 1,000 | 60,000 |
| Compatibility facade | 150 | — |

A file already over those limits may stay only as a reviewed `legacy` entry.
Legacy files may shrink but cannot grow past the recorded line or byte ceiling.
An exemption must be removed once the file is at or below the normal limit.
Temporary exemptions exist only in that checked-in configuration.

The checker also fails closed for missing legacy files, completed exemptions,
duplicate inventory or root entries, unsafe paths, and symlinks.

## Public facades and owned domains

Callers keep importing the original module paths. Each facade re-exports the
same public names and owns the domain modules below it. Domain modules import
siblings or other packages; they must not import their own facade.

### `tools/codekeeper/src/cli.mjs`

Lightweight entry for `check-config` and `agent-settings`. Every other command
dynamically loads `tools/codekeeper/src/cli-heavy.mjs`. Those two commands must
not evaluate the Agents SDK, GitHub mutation, publication, validation, or
workspace runtime.

### `tools/codekeeper/src/lib/github.mjs`

Public names: `GitHubClient`, `isAmbiguousGitHubMutationError`,
`isOwnedMarkerComment`, `resolveGraphqlUrl`.

| Module | Owns |
|---|---|
| `github/transport.mjs` | Trusted API-origin validation, request execution, authentication headers, JSON parsing, retries |
| `github/pagination.mjs` | REST `Link` parsing, page traversal, repeated-link detection, page budgets |
| `github/graphql.mjs` | GraphQL request execution and cursor traversal |
| `github/mutation-guard.mjs` | Begin mutation, expected state, stale-state detection, ambiguous-write reconciliation, post-write re-read |
| `github/issues.mjs` | Issue reads, mutation, inventory, duplicate and maintenance-issue lookup |
| `github/comments.mjs` | Issue and review comments, marker lookup, create/update, recent-comment windows |
| `github/labels.mjs` | Label inventory, Codekeeper-owned labels, create/apply/remove |
| `github/pulls.mjs` | Pull metadata, files, reviews, threads, base/head verification, branch state |
| `github/client.mjs` | `GitHubClient` composition |
| `github/index.mjs` | Public re-exports consumed by the facade |

### `tools/codekeeper/src/lib/publish.mjs`

Public names: `publishReview`, `publishAudit`, `publishIssue`, `publishFix`,
plus the existing repair-lease and trust helpers re-exported from
`publish/index.mjs`. Live automatic-repair dispatch stays on the facade.

| Module | Owns |
|---|---|
| `publish/artifacts.mjs` | Artifact loading, manifest verification, expected digest checks, sealed-candidate loading |
| `publish/common.mjs` | Shared input validation, GitHub client construction, dry-run handling, result helpers |
| `publish/review.mjs` | Review publication, labels/comments, repair dispatch, review gate result |
| `publish/issue.mjs` | Issue triage publication, duplicate handling, labels/comments, implementation dispatch |
| `publish/audit.mjs` | Maintenance finding publication, duplicate reconciliation, private security withholding |
| `publish/fix.mjs` | Issue-implementation and existing-PR repair publication, result reconciliation |
| `publish/repair-pr.mjs` | Commit/push phases, remote branch re-read, PR create/update, thread resolution |
| `publish/index.mjs` | Public re-exports consumed by the facade |

### Agent runtime boundary

`tools/codekeeper/src/lib/agents-runtime.mjs` is now a compatibility facade.
`agents-runtime-provider.mjs` owns provider selection, tracing, cleanup, and
provider-specific execution; `agents-runtime-core.mjs` owns frozen-bundle
workspace execution and coordinator orchestration. The public facade continues
to expose `runAgentFromBundle`, `runWorkspaceAgentFromBundle`,
`configureOpenAITracing`, `isProviderCleanupTimeout`, and
`providerCompatibleJsonSchema`.

## Original monolith sizes

Measured on the pre-split tree versus the current facades.

| Module | Before (lines / bytes) | After (lines / bytes) |
|---|---:|---:|
| `tools/codekeeper/src/lib/github.mjs` | 1,502 / 61,928 | 6 / 133 |
| `tools/codekeeper/src/lib/publish.mjs` | 1,448 / 63,585 | 122 / 4,344 |
| `tools/codekeeper/src/lib/agents-runtime.mjs` | 1,143 / 49,648 | 119 / 6,118 |
| `tools/codekeeper/src/lib/agents-runtime-provider.mjs` | — | 746 / 32,617 |
| `tools/codekeeper/src/lib/agents-runtime-core.mjs` | — | 426 / 18,258 |

Replacement domain modules stay under the normal 800-line and 40,000-byte
limits. No empty domain directories or transitional `*-core` modules remain.

## Current exemptions

These ceilings were measured on this tree. They are not targets to grow into.

| File | Lines | Bytes |
|---|---:|---:|
| `tools/codekeeper/src/lib/git.mjs` | 884 | 32,028 |
| `tools/codekeeper/test/commands.test.mjs` | 1,163 | 35,565 |
| `tools/codekeeper/test/integration.test.mjs` | 1,558 | 67,318 |
| `tools/codekeeper/test/publish.test.mjs` | 1,740 | 73,858 |

Remove a legacy entry only after the file is at or below the normal limit, or
after a behavior-preserving split has replaced it with bounded modules.

## Check

```bash
npm run architecture:check
```

The root `npm run check` command runs the same gate. It rejects local import
cycles and any import from a domain module back through its facade.

## Mirrored helpers

A few installer files are physical copies of runtime helpers so the published
package stays self-contained. The runtime file is canonical.

| Canonical | Published copy |
|---|---|
| `tools/codekeeper/src/lib/label-ownership.mjs` | `packages/codekeeper/src/label-ownership.mjs` |

```bash
npm run helpers:check
node scripts/sync-mirrored-helpers.mjs --write
```

`--check` fails if the copies differ. `--write` copies canonical bytes into the
published path. Do not replace a published copy with an import outside
`packages/codekeeper`. Add another pair only when the files are byte-identical
and the installer must own its own copy.
