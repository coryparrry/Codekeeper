# Rivet gh-aw migration contract

## Decision

Codekeeper is being renamed to **Rivet** while its bespoke execution platform is
replaced with workflows compiled by GitHub Agentic Workflows (`gh-aw`). Rivet
remains the product and authority control plane. gh-aw owns generic workflow
compilation, engine setup, sandboxing, MCP plumbing, action pinning, and Safe
Outputs.

The supported integration boundary is a checksum-verified, release-pinned
`gh-aw` CLI binary. Rivet renders standard Agentic Workflow Markdown and
inspects the generated `.lock.yml` workflow. It does not initially import
gh-aw's Go packages, construct gh-aw internal models, maintain a compiler fork,
or reproduce the complete gh-aw schema.

This contract replaces further expansion of the legacy orchestration design.
Existing behavior stays available until its replacement passes the milestone
that owns it.

## Product identity

The finished product uses one canonical identity:

| Surface                      | Canonical value                                   |
| ---------------------------- | ------------------------------------------------- |
| Product                      | Rivet                                             |
| npm package                  | `@coryparry/rivet`                                |
| executable and owner command | `rivet` and `/rivet`                              |
| domain configuration         | `.github/rivet.json`                              |
| managed state                | `.github/rivet/` and `.github/rivet-release.json` |
| workflow prefix              | `rivet-`                                          |
| environment prefix           | `RIVET_`                                          |
| source modules               | `packages/rivet/` and `tools/rivet/`              |
| setup branch                 | `rivet/setup`                                     |

Legacy names may exist only in an explicit, tested migration reader or release
bridge. They must not appear in a new installation, generated workflow, App
identity, command, label, check, marker, branch, or user-facing message.

The repository and npm package are external release identities. Source changes
prepare those moves, but a pull request does not prove that either external
rename or publication has happened.

## Target architecture

```text
Rivet CLI and TUI
  -> Rivet domain configuration and authority calculation
  -> managed Agentic Workflow Markdown
  -> pinned, checksum-verified gh-aw compiler
  -> inspected .lock.yml workflow
  -> upstream gh-aw runtime plus narrow Rivet extensions
  -> GitHub Actions
```

Rivet owns:

- installation, update, verification, and migration;
- GitHub App setup and effective-permission verification;
- capability-to-authority calculation and human approval;
- reviewer, repair, issue, and maintenance behavior;
- stable checks, labels, comments, commands, and state lineage;
- prompts, evaluations, compatibility policy, and release qualification.

gh-aw owns:

- Agentic Workflow parsing and compilation;
- engine and sandbox integration;
- MCP and generic tool plumbing;
- generic Safe Outputs and GitHub Actions job construction;
- upstream action selection, pinning, and compiler validation.

## Trust and authority invariants

1. Users do not need a global `gh-aw` installation.
2. The compiler version, release asset, and SHA-256 checksum are pinned by a
   Rivet compatibility manifest. `latest`, `main`, and a global fallback are
   forbidden.
3. A compiler acquisition or validation failure leaves installed workflows
   unchanged.
4. Standard Agentic Workflow Markdown is the interchange format.
5. Native AW imports cannot replace Rivet-owned triggers, owner authorization,
   protected paths, validation, App credential mapping, publication rules, or
   state markers.
6. Remote imports use full commit SHAs. Authority-bearing local imports are
   compiled with `inlined-imports: true` when the pinned compiler supports the
   required semantics.
7. Compile success is not authority approval. Rivet separately inspects
   triggers, permissions, secrets, variables, action SHAs, repositories,
   checkouts, write-capable jobs, and detectable Safe Outputs.
8. Any unclassified authority change requires explicit advanced review.
9. App permission widening is displayed, approved by a human through GitHub,
   and verified before the capability enters an update PR.
10. Models never receive App credentials and never grant, widen, validate, or
    publish their own authority.
11. Repair remains exact-head, owner-authorized, protected-path bounded,
    deterministically validated, stale-head checked, and independently
    re-reviewed. Merge stays disabled during migration.
12. The final design has one generic execution foundation. It cannot retain the
    old runtime while adding both a new adapter platform and a broad fork.

### Runtime prompt ownership

The pinned gh-aw version must be tested rather than inferred. Current gh-aw
documentation states that workflow Markdown bodies are loaded at runtime.
Therefore `inlined-imports: true` is not by itself proof that the main Rivet
prompt is default-branch owned.

The compiler-boundary spike must record the exact source and ref used for:

- the main Markdown body;
- imported policy and prompt content;
- inline subagent instructions;
- workflow frontmatter and generated lock metadata;
- every checkout in `pull_request_target` review execution.

Review migration stops if a pull request can change the prompt, policy, agent
instructions, protected paths, or publication contract used to review that
same pull request. The accepted solution must use an upstream-supported
trusted-source mechanism or a narrow, reviewed Rivet extension. It must not be
papered over by a custom workflow merge engine.

## Configuration levels

Rivet schema v4 describes product intent rather than mirroring gh-aw:

- **Normal Rivet:** review, repair, issue triage, maintenance, merge policy,
  owner approval, model selection, and validation.
- **Advanced Rivet:** paths, budgets, turn limits, subagents, schedules, labels,
  escalation, tool categories, and concurrency where these affect the product.
- **Native AW:** optional pinned imports for niche or newly released upstream
  features.

A native feature is promoted into Rivet only after it proves broadly useful.
Promotion should add a domain setting, one template mapping, an authority
summary, and focused tests; generic execution remains upstream.

## Runtime strategy

The first working review uses the exact upstream actions emitted by the pinned
compiler. Rivet-specific state, validation, identity, or publication behavior
may use small custom actions where upstream Safe Outputs cannot prove a Rivet
invariant.

A downstream `gh-aw-actions` mirror is an experiment, not an assumption. It is
eligible for production only when it is generated, records the exact upstream
SHA, preserves notices, applies small overlays automatically, pins a full
commit, reports conflicts, and survives one adjacent-version upgrade without
broad manual maintenance. If that gate fails, Rivet retains upstream generic
actions and only its narrow extension actions.

## Delivery gates

Every stage is an independently testable stacked PR below 3,000 changed lines.
The stack is extended only after the previous hard gate passes.

1. **Migration contract and legacy baseline.** Freeze the final legacy source,
   capabilities, providers, evaluation fixtures, size, topology, and evidence
   gaps.
2. **Pinned compiler manager.** Acquire one exact platform asset, verify its
   published checksum, cache it under a Rivet-owned path, and refuse fallback.
3. **Renderer, validator, and inspector.** Render one review fixture, run strict
   compile/JSON validation, and inspect the compiled authority surface.
4. **Native import and prompt-trust proof.** Pass through an unmodeled native AW
   feature and prove the exact trusted runtime source for policy and prompts.
5. **Runtime extension proof.** Exercise only Rivet-specific invariants against
   upstream actions.
6. **Generated mirror experiment.** Automate a candidate action mirror without
   adopting it.
7. **Adjacent-version upgrade.** Recompile, compare authority, sync the runtime
   candidate, rerun tests, and decide upstream actions versus the mirror.
8. **Review-only installation.** Install one-command review with App identity,
   authority summary, setup PR, and adversarial prompt/policy fixtures. Repair,
   issue implementation, and merge remain off.
9. **Review parity and schema v4.** Port reviewer behavior and supported
   subagents, migrate meaningful v3 settings, and report unsupported provider
   or configuration differences.
10. **Owner-authorized repair.** Add minimal state, exact owner command,
    protected paths, validation, stale-head checks, publication, and re-review.
11. **Issue triage and maintenance.** Migrate report-only modes before enabling
    their separately authorized mutation paths.
12. **Existing-install migration and Rivet rename.** Regenerate managed files,
    preserve adopter-owned overrides/imports, migrate secrets and variables
    deliberately, publish the package bridge, and prove an external update.
13. **Legacy deletion.** Remove replaced orchestration, provider, MCP, sandbox,
    mutation, packaging, and duplicated upstream tests. Remove the temporary
    generation selector only after the rollback window.

After each stage, review the layer diff against `main` for unnecessary comments,
abnormal defensive code, type bypasses, nesting, duplication, and inconsistent
style. Cleanup must preserve behavior and remain in the owning layer.

## Release evidence

Evidence stays boundary-specific and exact-state bound:

- source checks prove source behavior only;
- compiler fixtures prove the pinned binary and generated workflow only;
- package staging proves packaged bytes, not npm publication;
- an installed adopter proves installation, not a release candidate;
- a live review or repair proves only its exact package, workflow, App, and head;
- external repository and npm renames require separate receipts.

Generated manifests, copied helpers, workflow pins, package metadata, and source
integrity are dependent outputs. They are refreshed only after the source layer
is complete, following `AGENT_RELEASE_SAFETY.md`.

## Completion criteria

The migration is complete when:

- new users install and operate Rivet without installing gh-aw;
- every shipped workflow compiles with the supported pinned combination;
- compiled authority never exceeds approved product authority silently;
- review and repair retain exact-head, credential, validation, and lineage
  guarantees in controlled adopter runs;
- external install/update proof uses the Rivet package and identities;
- all supported modes use gh-aw-based workflows;
- the legacy runtime and temporary selector are removed;
- substantially more bespoke platform code is deleted than added.
