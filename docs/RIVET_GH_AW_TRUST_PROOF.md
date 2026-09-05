# Rivet gh-aw self-review trust proof

Status: compiler-boundary proof for `gh-aw v0.86.2`. This is not a live GitHub
Actions or adopter-installation receipt.

## Result

The Rivet review fixture is self-contained at the prompt boundary. Its native
extension and main Markdown body are embedded in the generated lock file, and
the compiled workflow contains no runtime prompt imports. A pull request that
edits the workflow source or extension cannot change the prompt used by that
same `pull_request_target` run.

The generated workflow still checks out repository metadata. Every checkout:

- uses the current repository without an explicit ref or alternate path;
- persists no credentials; and
- therefore resolves to the base repository default branch under
  `pull_request_target` semantics.

## Exact upstream boundary

Rivet pins:

- `github/gh-aw` compiler release `v0.86.2` at commit
  `48e5fa3ff52294d91d97715017a9f8693a48387f`; and
- `github/gh-aw-actions` at commit
  `6aab9e5b5c91c615506061f09bedd81a23babe3c`.

The second pin is passed through `--action-tag` as a full commit. This is
required because the upstream compiler can otherwise emit the movable
`github/gh-aw-actions/setup@v0.86.2` tag when its action-resolution cache or
GitHub API access is unavailable.

The pinned upstream runtime importer resolves local files within
`GITHUB_WORKSPACE` and reads the resolved path at runtime:

- [runtime import path resolution](https://github.com/github/gh-aw/blob/48e5fa3ff52294d91d97715017a9f8693a48387f/actions/setup/js/runtime_import.cjs#L966-L1056)
- [runtime import file loading](https://github.com/github/gh-aw/blob/48e5fa3ff52294d91d97715017a9f8693a48387f/actions/setup/js/runtime_import.cjs#L1058-L1092)

GitHub documents that `pull_request_target` runs in the base repository's
default-branch context, and an `actions/checkout` step without an explicit ref
uses that trusted base state:

- [events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)
- [secure use of `pull_request_target`](https://docs.github.com/en/actions/reference/security/secure-use#preventing-pwn-requests)

## Rivet constraints

The renderer accepts native extensions only below `.github/rivet/aw/` and only
as local Markdown files. It does not accept parent traversal, another local
namespace, a remote repository, or a floating remote ref.

The compiled trust receipt fails unless all of these remain true:

1. `pull_request_target` is the only trigger.
2. Strict compiler mode and the compiler's matching trigger manifest are present.
3. `inlined-imports: true` is recorded.
4. The resolved native-import inventory exactly matches the approved inventory.
5. No runtime prompt imports remain.
6. Every action uses a full commit SHA.
7. No additional repository is checked out.
8. Every checkout has no explicit repository, ref, or path and persists no credentials.
9. The job, condition, permission, environment, script, runner, container, and
   concurrency inventory matches the approved review authority.

The main workflow keeps final control of its trigger, permissions, disabled
agent checkout, and Safe Output limits. The native fixture exercises an
upstream-only feature (`engine.mcp.tool-timeout: 4m`) and contributes prompt
content. The generated lock contains both the resulting 240-second timeout and
the imported instructions without adding a Rivet schema field.

The review authority comparison normalizes only supported product choices.
For `review.maximumFindings`, it normalizes the matching Safe Output limit,
prompt text, tool metadata, handler configuration, and generated script before
checking the approved authority digest. The compiled limit must still be an
integer from 1 to 20 and must exactly equal the configuration requested by the
installer. A different requested count or any other code, job, permission,
condition, or script change fails the trust check.

Automatic tagging has two narrow App-authenticated jobs. After context
preparation, the pending job runs for an eligible event before model analysis
and leaves only `review needed` from Rivet's four managed labels, including
when no review snapshot is available.
The final job may select `changes required`, `review needed`, or `merge ready`,
and may add `needs tests`, only after successful review publication with a
structured tag decision that agrees with the review body's single
merge-readiness status.
Both jobs recheck the event pull request's identity, open state, base SHA, and
head SHA around their writes, preserve unrelated labels, and verify the final
managed set.

## Evidence

The package tests inspect the real compiler output and include adversarial
variants for a PR-head checkout, runtime prompt loading, a movable action ref,
an unapproved import, a mismatched custom finding limit, injected compiled
code, stale pull-request state, failed publication, and label-set drift. The
real pinned compiler also passes strict compile and JSON validation for the
fixture.

Still required before installation or production claims:

- a live `pull_request_target` run in a controlled adopter repository;
- a PR that edits the workflow, prompt, policy, and native extension while the
  run proves it used the base-branch lock and embedded prompt; and
- verification of the actual GitHub App/token mapping introduced by the
  installation layer.
