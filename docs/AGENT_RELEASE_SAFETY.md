# Agent change and release safety

This document is the release-safety contract for agents editing Codekeeper. It
maps the places where one source change can silently invalidate another
representation, and gives the verification required before a release claim.

The central rule is:

> A check is a pass only for the boundary it exercises. A green unit suite does
> not prove that generated assets, packaged files, adopter workflows, GitHub
> rulesets, npm state, or a live adopter installation are correct.

If the checkout, branch, commit, dependency installation, generated output, or
external state changes during verification, invalidate affected evidence and
start that verification again.

## 1. Before editing

Record the exact state before opening a change:

```bash
git status --short --branch
git rev-parse HEAD
git branch --show-current
git log -1 --oneline --decorate
```

Then:

1. Preserve every unrelated modified and untracked path. Do not reset, clean,
   stash, overwrite, or commit another agent's work.
2. Confirm the repository is on the intended non-release branch. Do not infer
   that the current `HEAD` is still the one reviewed earlier.
3. Classify every touched path using the impact map below.
4. Find the canonical producer and every generated, copied, staged, installed,
   or executed consumer before editing.
5. Treat credentials, App keys, live traces, npm tokens, and adopter evidence as
   external secrets. Never put them in arguments, logs, fixtures, commits, or
   evidence bundles.
6. If another process advances `HEAD` or changes an affected file, stop and
   rebind the review to the new state.

A source release requires a clean checkout. The legacy Codekeeper package-stage
and candidate-pack paths are retired while Rivet's release boundary is
established; use the Rivet migration documentation for current qualification.

## 2. The coupled release graph

The same product crosses several independently fallible boundaries:

```text
runtime source and policies
        |  tooling manifest and Rivet workflow/compiler inputs
        v
installer assets and generated workflow callers
        |  locked runtime install and YAML parse
        v
installed adopter workflows and runtime
        |  App authorization, publication, evidence, GitHub state
        v
live release, live adopter acceptance, and registry receipt
```

The root source archive is a separate integrity plane:

```text
tracked Git content -> MANIFEST.sha256 -> git archive -> source-release verifier
```

A change is not release-ready until the affected paths in both graphs have
passed their relevant gates.

## 3. Impact map

Use the narrowest row that covers the change, then include every downstream row
named in its “also verify” column.

| Touched surface | Typical breaking point | Required local verification | Also verify |
|---|---|---|---|
| `tools/codekeeper/src/**`, agents, presets, schemas, provider code | Runtime behavior, provider routing, output schemas, retries, timeouts, cancellation, workspace isolation, or mutation authority changes without a matching packaged/runtime contract | `cd tools/codekeeper && npm run check`; run the focused runtime, provider, schema, isolation, and audit tests | tooling manifest, generated package distribution, policy-validator copy, embedded runtime, workflow execution |
| `.github/codekeeper.json` and policy validators | Closed-schema rejection, invalid provider/model settings, capability accidentally enabled, owner/label drift, or a trusted policy read from the wrong ref | `node tools/codekeeper/src/cli.mjs check-config --config .github/codekeeper.json`; focused policy/config tests | default-branch policy checkout, profile provenance, workflow authorization, App permissions |
| `packages/codekeeper/src/**` and installer CLI/TUI | Installer plans the wrong files, overwrites adopter-owned content, changes settings authority, breaks `doctor`, `verify`, update, or clean-room setup | `cd packages/codekeeper && npm run check`; focused installer, preflight, TUI, package-acquisition, and repository-artifact tests | stage, tarball, exact-version install, clean adopter repository |
| `packages/codekeeper/assets/**` or generated `metadata.json` | Packaged agent profiles, policies, workflow templates, digests, source paths, or release metadata diverge from canonical source | package asset/plan/contract tests; `cd packages/codekeeper && npm run check` | YAML parse, rendered adopter files |
| `tools/codekeeper/tooling-manifest.json` or runtime payload | Generated inventory is stale, incomplete, or records a different source payload | `cd tools/codekeeper && node scripts/generate-tooling-manifest.mjs --check`; runtime check | package runtime contents and release provenance |
| `.github/workflows/**`, action files, or `examples/workflows/**` | Trigger, input, secret, permission, job dependency, checkout ref, action pin, runner, or caller/reusable-workflow contract breaks | root `npm run check`; actionlint; Ruby/Psych YAML parsing; workflow contract tests | packaged workflow assets, rendered adopter workflows, protected live checks |
| Review or `pull_request_target` caller | Untrusted pull-request code is checked out or executed on a privileged runner, or required review authority is bypassed | workflow contract tests plus static inspection of checkout refs and job permissions | a controlled same-repository adopter PR |
| Runtime workflow consumer | One isolated job fails to acquire/reverify the exact package, install the locked runtime, or transfer a frozen artifact | workflow package-contract tests | workflow run evidence and exact package receipt |
| `package.json`, package lockfiles, runtime lockfile, Node/npm versions | Lifecycle scripts, bundled Ink/React dependencies, nested runtime, or supported Node line changes without reproducible installs | clean `npm ci --ignore-scripts --no-audit --no-fund` on Node 22 and 24; package checks | exact npm 12.0.2 pack and install canary |
| Generated package source commit or source repository identity | Installer records a stale, unreachable, future, self-referential, or wrong-owner commit | package contract and distribution tests; verify full SHA and default-branch ancestry for release packs | inspect the exact build commit contents, not ancestry alone |
| `MANIFEST.sha256` (compatibility-only), release docs, or tracked files | Source archive no longer represents the reviewed tracked tree | `bash scripts/release-source.sh --verify` from a clean final commit | archive receipt and release tag |
| Acceptance harness, evals, fixtures, or test oracles | A fixture passes while the real workflow, package, App identity, or mutation boundary is broken; failure is converted into success | `cd acceptance && npm run check`; `cd tools/codekeeper && npm run eval:offline`; inspect assertions and skips | private live adopter acceptance where authorized |
| Release governance, ruleset, release workflow, or npm workflow | Checked-in protection is not applied live; required checks, npm environment, public visibility, token, tag, or registry state is wrong | `npm run governance:check`; `node scripts/repository-governance.mjs --check-remote` | live rulesets, required checks, tag immutability, npm receipt, GitHub Release |
| Documentation, README, examples, or version-facing copy | Users follow commands, package names, versions, paths, or workflows that no longer exist | relevant documentation contract tests and root `npm run check` | clean package install and published package README |

When a row is not applicable, record why. “Only documentation” is not a safe
assumption when the document contains an install command, workflow snippet,
package version, source pin, policy key, or release procedure.

## 4. Local verification gates

Run gates in order. Stop at the first failure; do not interpret a later check as
a waiver for an earlier one.

### Gate A — exact state and preservation

```bash
git status --short --branch
git diff --check
git rev-parse HEAD
```

Pass criteria:

- the intended commit is recorded;
- unrelated changes remain untouched;
- no secret, local acceptance state, or generated output is accidentally in
  the change;
- the working tree is clean before a release build.

A changed `HEAD`, changed package lock, or changed generated file invalidates
later evidence.

### Gate B — repository and runtime checks

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check

cd tools/codekeeper
npm ci --ignore-scripts --no-audit --no-fund
node src/cli.mjs check-config --config ../../.github/codekeeper.json
npm run check
cd ../..
```

The root check covers lint/format, governance, module boundaries, local import
cycles, mirrored helpers, release-tag tests, and source-release worktree
verification. The runtime check covers syntax, the generated tooling manifest,
coverage, runtime tests, and hardening audits.

A failure caused by billing, a missing runner, unavailable credentials, or an
environment outage is an evidence gap, not a product pass or product failure.
Record the infrastructure cause and run the safe local checks that remain
available.

### Gate C — Rivet and structural contracts

```bash
npm run rivet:check
npm run architecture:check
```

Then run focused tests for every affected Rivet source, workflow, or packaged
asset.

Do not treat source-text assertions as end-to-end workflow evidence. Confirm that
the assertion reaches the production path and rejects a plausible wrong
implementation.

### Gate D — generated and provenance synchronization

Run only after source changes are complete:

```bash
node tools/codekeeper/scripts/generate-tooling-manifest.mjs --check
```

If a runtime payload changed, generate the tooling manifest before committing
the source change. Never hand-edit generated hashes, workflow copies, or package
source commits.

The root `MANIFEST.sha256` inventory is compatibility-only for remaining
source-pinned installations; do not extend it.

Confirm the exact source checkpoint contains the intended runtime and workflow
contents. An ancestor can still be the wrong release checkpoint.

### Gate E — Rivet delivery boundary

The legacy Codekeeper package staging and candidate-pack tooling are retired.
No local npm tarball or pre-publication package receipt is produced by this
repository. Use the Rivet migration documentation for current delivery and
release qualification.

### Gate F — workflow and trust-boundary proof

For every changed workflow or embedded workflow asset, verify:

- every third-party action is pinned to a reviewed full commit;
- callers invoke only adopter-local reusable workflows and pass one exact
  package version plus SHA-512 receipt;
- every isolated consumer acquires and independently reverifies that package;
- checkout refs use the trusted default branch where policy or credentials are
  involved;
- `pull_request_target` callers never execute pull-request code on a
  privileged runner;
- token-free authorization and candidate sealing happen before App-token
  creation;
- model, workspace, trace, and App credentials remain separate and never appear
  in evidence or specialist environments;
- job permissions, `needs`, concurrency, cancellation, artifact names, and
  outputs still form a valid failure-closed chain;
- the source workflow and package-rendered workflow remain semantically aligned.

Use both actionlint and Ruby/Psych parsing. A YAML parser pass alone does not
prove GitHub expression, permission, trigger, or reusable-workflow semantics.

### Gate G — behavior and adopter proof

Offline evaluation:

```bash
cd tools/codekeeper
npm run eval:offline
```

This proves only deterministic fixture assertions. It does not prove provider
availability, GitHub mutations, App identity, npm publication, or a live
adopter.

When authorized, use a private disposable adopter repository and retain
evidence for:

1. package identity, version, SHA-512, release manifest, and source checkpoint;
2. `codekeeper verify` from a clean checkout;
3. configured App identity, selected repository installation, least-privilege
   permissions, and stored private key;
4. no-mutation credential verification;
5. review, issue, maintenance, and controlled-fix scenarios relevant to the
   release;
6. stale-head, duplicate-event, retry, timeout, and rerun behavior;
7. cleanup and restoration of the adopter's enabled/disabled state.

Do not substitute a local fixture, fake `gh`, hermetic adapter, or source test
for live adopter proof.

### Gate H — live release state

Before publication, separately confirm the external boundaries:

- the protected `main` ruleset is live and requires the intended checks;
- immutable `codekeeper-vX.Y.Z` tag protection is live;
- the npm environment, publisher credentials, provenance prerequisites, and
  public repository state are correct;
- the release tag resolves to the exact source commit;
- npm `view`, `pack`, and exact-version install receipts agree on name,
  version, tarball URL, and SHA-512;
- registry propagation retries only for confirmed missing-release responses
  (`E404`, `ETARGET`, or the documented “No matching version found” form);
- unrelated npm authentication, network, malformed receipt, or registry errors
  fail closed;
- the GitHub Release and assets correspond to the same tag and source commit;
- a post-publication installed-adopter verification is retained separately from
  pre-publication candidate evidence.

A successful local build is not evidence that any of these live conditions is
true.

## 5. Failure modes agents must stop on

Stop and report an evidence gap or blocker when:

- `HEAD` changes after validation begins;
- the working tree is dirty during a release build;
- a generated manifest, source pin, lockfile, embedded asset, or root manifest
  is stale;
- a package receipt has an unexpected JSON shape or mismatched integrity;
- a registry lookup fails for a reason other than confirmed propagation delay;
- a workflow parses but its caller, inputs, permissions, or `needs` graph do not
  match the consumer;
- a test passes only because it mocks the production boundary or shares the
  implementation's oracle;
- a live check cannot run because credentials, billing, runner, GitHub, npm, or
  adopter state is unavailable;
- an agent cannot prove that a changed source file reaches the packaged and
  installed consumer;
- evidence refers to a different commit, package version, tag, or adopter run;
- a change requires a new permission, secret, runner, registry, or external
  service not explicitly authorized.

Never turn an infrastructure failure into a product conclusion, and never turn
missing evidence into a pass.

## 6. Final evidence packet

An agent should hand off:

- exact commit SHA and branch;
- initial and final `git status --short --branch`;
- changed paths and impact rows;
- commands run, exit status, and focused result;
- generated files and synchronization checks;
- package filename, version, SHA-512, release-manifest SHA-256, and source commit;
- workflow/action/policy contract results;
- live boundaries that were verified and those that were not;
- known limitations, skipped tests, and infrastructure blockers.

The release owner should refuse a release claim if the packet contains only
“tests pass” without boundary-specific receipts.

## 7. Required final sequence

For runtime or packaged-source changes, use this order:

1. Finish source changes and affected tests.
2. Generate and check the tooling manifest when runtime payloads changed.
3. Synchronize mirrored helpers and pinned policy copies when required.
4. Commit the source and generated changes, excluding `MANIFEST.sha256`.
5. From that clean commit, run `node scripts/refresh-release-manifest.mjs`.
6. Do not edit tracked files after refreshing the root manifest.
7. Run `bash scripts/release-source.sh --verify` and record the exact passing
   commit SHA.
8. Build and verify the exact package candidate.
9. Run the separate live release and adopter gates when publication is authorized.

If any later tracked-file edit occurs, repeat the manifest refresh and final
source verification sequence. A version bump, tag, or npm publication does not
replace the pack-time source commit; that commit is generated from the exact
build `HEAD` or candidate SHA.

## 8. Scope and support boundary

This contract covers the supported Node 22+ package, GitHub Actions workflows,
npm publication, GitHub App authorization, and private-adopter acceptance
paths. Forks, GitHub Enterprise Server, persistent self-hosted runners, and
unsupported external infrastructure remain outside the supported release proof
unless a separate test contract is added.
