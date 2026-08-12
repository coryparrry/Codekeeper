# Consolidated Multi-Review Report — Codekeeper full repository (`main`)

**Date:** 2026-08-11
**Branch:** `main` (vs `origin/main`, even — full-repo surface, not a branch diff)
**Agents:** 15/18 review completed + 1 validator; 3 review agents failed after retry (Bugbot connection, Security Review empty-diff hard-fail) and 3 substitutes exhausted without output — see inventory
**Validation:** complete ([Findings Validator](625eb7c4-8d25-48ad-92c4-6a3bdd6d940b))

## Executive verdict

Codekeeper’s trust model is unusually strong for an AI-agent GitHub Actions system: SHA-pinned first-party actions, fail-closed tooling-manifest verification, sealed artifacts, fd-passed App PEMs, owner-gated commands, and deterministic patch/policy backstops on every write path. **No Critical findings survived validation.**

The residual risk is not “unauthenticated RCE on every adopter,” but three Highs that matter before the next release:

1. **Installer pins an unreviewed source commit** (`SOURCE_COMMIT` is not an ancestor of `main`).
2. **Duplicate-issue closure is dead by construction** (staleness check invalidated by the publisher’s own comment).
3. **Auto-repair’s one-pass label can be burned by cancel-in-progress** before dispatch starts.

Cyber-security posture: supply-chain and auth surfaces are largely sound under the shipped job topology. The most-cited security issue — denylist env scrubbing for validation commands — is **confirmed but demoted to Medium** because verify jobs carry no secrets today (the invariant lives in YAML, not the runtime). The third-party `openai/codex-action` remains a **High supply-chain exception** inside the trust boundary, not a Critical unauthenticated break.

Separate “security clean enough to ship with eyes open” from “lifecycle residual risk”: security is in good shape relative to the threat model; lifecycle/process integrity (installer pin, dead duplicate-close, auto-repair cancel race) is where the Highs sit.

## Review inventory

| Wave | Count | Status | Agent links |
|---|---:|---|---|
| Bugbot | 0/3 usable | Failed (connection interrupted ×2 attempts); substituted | originals + retries failed; substitutes: [real bugs](7106b83f-068b-4846-8bd2-7efc4f99de66), [races](93f253da-5608-4e67-ae19-dc28720ce147); auth/trust substitute exhausted |
| Security Review | 0/3 usable | Failed (`natural language` unsupported, then empty-diff hard-fail); substituted | [workflows/secrets](fe4f7610-d55a-4b72-9ba8-0449798923d0), [installer/keys](85c2de46-2cbd-4e12-b671-26eb3d73360a), [injection/policy](1e655303-a6fc-4e7c-9072-62517ad7d419) |
| Thermos | 2/3 | 1 exhausted | [bugs/security](8f7e22cd-0bc0-4f3a-add7-4888ab3a6847), [code-quality](af6a1abf-ea21-4a20-b385-cd8be26a2f97); concurrency exhausted |
| Bug Hunt | 5/6 | 1 API-limit | [failure seams](798481e6-a392-4f79-8992-bcac03635d71), [regression](bc0cb49a-6479-4659-b5b3-e48070953f58), [proof](c80cce96-3bb5-40a3-9145-7a2c2afd1a26), [privacy](ad842fce-fa89-4b31-aff7-d1219900203d), [shell/installer](b37de92a-da05-4f6f-91cd-b3d17435d440); reproduction exhausted |
| Team Review | 3/3 | Complete | [security](4aaf2617-8351-47fa-b0ab-f7733ab3359e), [performance](70d2861e-04a4-484d-ac36-c511702a9cca), [architecture](d818ee89-a11f-49e5-9dff-fbedc2f137da) |
| Findings Validator | 1/1 | Complete | [Findings Validator](625eb7c4-8d25-48ad-92c4-6a3bdd6d940b) |

## Validation summary

| Confirmed | Weakened | Falsified | Needs proof |
|---:|---:|---:|---:|
| 6 (F5, F7, F8, F9, F10, F11, F12 — F3 confirmed-then-lowered) | 4 (F1, F2, F3 severity, F4) | 1 (F6) | 0 |

Counts by post-validation severity among candidates: **Critical 0 · High 4 (F5, F7, F8 + demoted F1) · Medium 7 · Dropped 1**.

## Consolidated findings (deduplicated + validated)

### Critical

_None after validation._

### High

| ID | Location | Finding | Sources | Validation |
|---|---|---|---|---|
| F5 | `packages/codekeeper/src/constants.mjs:4-5`, `assets/metadata.json` | Installer `SOURCE_COMMIT` (`8d2ea1aa…`) is **not** an ancestor of `origin/main`; only on `origin/codex/optimize-codekeeper-agent-flow`. Generated adopters pin unreviewed tooling. | Architecture, Security pass 2 | **confirmed** — keep High |
| F7 | `tools/codekeeper/src/lib/publish.mjs:489-513` | Duplicate-issue closure is dead: triage marker comment bumps `updated_at`, then `currentIssue()` staleness check always fails. | Bug pass 2 | **confirmed** — keep High |
| F8 | `tools/codekeeper/src/lib/publish.mjs:441-451` + `codekeeper-review.yml` concurrency | `codekeeper:auto-repaired` is applied **before** `createRepositoryDispatch`; cancel-in-progress can burn the one-pass repair with no repair started. | Bug pass 2; related Security pass 1 H3 | **confirmed** — keep High |
| F1 | `.github/workflows/codekeeper-*.yml` `openai/codex-action@52fe01ec…` | Third-party Codex action (SHA-pinned but external npm payload) runs with `workspace_api_key` on untrusted CWD — standing exception to the repo’s own manifest story. | Security pass 1, Bug hunt 4/5 | **weakened** Critical→**High** (pinned + sandbox/drop-sudo) |

### Medium

| ID | Location | Finding | Sources | Validation |
|---|---|---|---|---|
| F3 | `git.mjs:208-240`, `validate.mjs:411` | `runValidationCommands` uses env **denylist**; misses `CODEKEEPER_*` keys. Allowlist fix unmerged. Live exploit masked by secret-free verify jobs. | Bug hunts 2/3/5/6, Security pass 3, Team Security | **confirmed**, severity **lowered** High→Medium (latent) |
| F2 | `codekeeper-fix.yml:92-100` | Command job mints write App token before JS `owner-command` auth (workflow `if` already gates association + exact body). | Security pass 1 | **weakened** Critical→Medium |
| F4 | `publish.mjs:526-534` | Marker trust weaker than comment-owned markers; not forgeable by arbitrary users (requires bot login+id+type). Privileged body-edit fingerprint hijack residual. | Bug hunt 3 vs Security pass 3 | **weakened** High→Medium |
| F9 | `git.mjs` `createPatch` + workspace artifact uploads | 1-day workspace-evidence artifact uploads policy-unvalidated `workspace.patch` + raw Codex output before validation. | Bug hunt 5 | **confirmed** Medium |
| F10 | `assets/workflows/maintain.yml`, `plan.mjs:531-539` | Schedule runs live (`dry_run` empty→false); recommended installer defaults enable repair/auto-merge (opt-out). Bundled policy itself stays off-by-default. | Team Security vs Thermos | **confirmed** Medium (both half-right) |
| F11 | `config.mjs:307-328` | Fix sandbox write gated only on `issues.allowAiImplementation`; `review.autoRepair` without it → silent read-only no-op. | Bug pass 1, Thermos | **confirmed** Medium |
| F12 | `cli.mjs:254-256` | Unsanitized `::error::` echo of stack/message — workflow-command forgery / log risk. | Security passes 1/3, Team Security | **confirmed** Medium |

### Low / structural (not fully re-validated; retained for follow-up)

- Performance: duplicated `prepare-*` + `fetch-depth: 0`; serial label API calls; unbounded maintenance-issue fetches; evidence JSON token bloat ([performance](70d2861e-04a4-484d-ac36-c511702a9cca)).
- Architecture/quality: 7-way hand-dispatched mode matrix; 19× duplicated tooling-bootstrap blocks; `harness.mjs` 1301-line monolith; `publish.mjs` verify/publish conflation; `65000` ceiling duplicated ([architecture](d818ee89-a11f-49e5-9dff-fbedc2f137da), [code-quality](af6a1abf-ea21-4a20-b385-cd8be26a2f97)).
- Installer TUI: typed provider secrets can be stored as a single character while reporting success ([Security pass 2](85c2de46-2cbd-4e12-b671-26eb3d73360a)).
- Lifecycle: `run_attempt`-suffixed artifacts break “Re-run failed jobs”; PR-repair subject freeze includes bot’s own comments ([Bug pass 2](93f253da-5608-4e67-ae19-dc28720ce147)).
- Observability: silent evidence-boundary retries; unverified `sourceSha` provenance field ([Bug hunt 4](c80cce96-3bb5-40a3-9145-7a2c2afd1a26)).

## Dropped / falsified by validator

| ID | Claim | Why dropped |
|---|---|---|
| F6 | `MANIFEST.sha256` has no CI check | **Falsified** — `codekeeper-self-test.yml` runs `release-source.sh --verify` on PR/push |

## Explicitly validated as sound

- First-party action SHA pinning + tooling-manifest digest verification (fail-closed, including verifier self-check).
- No `${{ github.event.* }}` text interpolated into `run:` shell blocks for slash-command bodies.
- Installer PEM path: fd-only `O_NOFOLLOW`, never read into Node memory; secrets not written into generated repo files.
- Sealed artifact + trusted-profile content-drift checks fail closed before GitHub mutation (profile `sourceSha` provenance field is unverified metadata, but content hash is real).
- Path policy / glob / symlink rejection; git argv arrays; `--no-force` pushes.
- Marker forgery by arbitrary PR authors: **not** a live unauth hole (bot identity required).
- #29 duplicate-pass elimination: net hardening; removed planner gate was same-trust-domain defense-in-depth.

## Cross-cutting themes

1. **Trust anchors held by process, not only mechanism** — installer `SOURCE_COMMIT`, duplicated workflow manifest literals, capability defaults in the installer UX.
2. **Workflow topology as security boundary** — verify jobs are secret-free by convention; runtime denylist would fail open if that topology changes.
3. **Codex / workspace specialist as the soft edge** — prompt-level network/credential barriers; pre-validation workspace artifacts; external action supply chain.
4. **Lifecycle vs integrity** — cancel-in-progress, comment-driven freezes, and self-invalidating staleness checks create availability/feature breaks without privilege escalation.
5. **Duplication discipline** — mode matrix, bootstrap blocks, hash-binding copied across modules; silent regression risk.

## Prove now / Fix next / Follow up later

### Prove now
1. **F5** — retarget `SOURCE_COMMIT` / `metadata.json` to an ancestor of `main` (or block install until release pin); add CI `merge-base --is-ancestor`.
2. **F7** — refresh `expectedUpdatedAt` after triage marker upsert (or reorder close before comment / drop dead path); add regression test that currently encodes the failure.
3. **F8** — dispatch repair first, then label; or clear label on dispatch failure / cancel.
4. **F3** — land allowlist env from `codex/propose-fix-for-validation-command-vulnerability` + canary unit test.
5. **F1** — vendor/hash-pin Codex npm payload or isolate key to a nested job with no write surface.

### Fix next
- F10 schedule dry-run default + installer capability opt-in for repair/auto-merge.
- F11 gate fix sandbox on repair authorization / `review.autoRepair`, not only issue implementation.
- F9 strip/policy-filter workspace.patch before artifact upload; shorten retention or restrict visibility.
- F12 / F2 sanitize `::error::` output; mint App token only after auth (defense-in-depth).
- F4 align `isTrustedMaintenanceIssue` with owned-marker-comment pattern when convenient.

### Follow up later
- Performance Highs (shallow checkouts, dedupe prepare).
- Decompose `harness.mjs` / `publish.mjs`; single `MODES` registry.
- TUI single-char secret bug; terminal-escape sanitize; `run_attempt` artifact naming; evidence-boundary logging.

## Per-wave one-liners

- **Security pass 1:** Criticals on Codex action + early App token; several injection surfaces clean.
- **Security pass 2:** Installer defenses strong; High on unmerged `SOURCE_COMMIT` pin.
- **Security pass 3:** Env denylist High (topology-masked); marker forgery not live.
- **Team security:** No Critical/High; Medium on live schedule + opt-out capabilities.
- **Team architecture:** Highs on manifest regen (later falsified) and installer pin drift.
- **Team performance:** #29 clean; remaining cost in double prepare + `fetch-depth: 0`.
- **Thermos security:** No Critical/High/Medium; Low sandbox-gating / runUrl validator skip.
- **Thermos quality:** Structural debt — 7-way mode dispatch + copied bootstrap blocks.
- **Bug hunt 2:** Release chain hash-locked; env denylist + unescaped titles + unbound workspace patch.
- **Bug hunt 3:** Both vuln branches still relevant on main (env denylist live; marker gap weakened by validator).
- **Bug hunt 4:** Profile/artifact invariants enforced; credential/network claim prompt-level for Codex.
- **Bug hunt 5:** PEM clean; workspace-evidence artifact is the privacy sink.
- **Bug hunt 6:** Installer hardened; hottest residual is `bash -c` validation in PR checkout.
- **Bug pass 1:** Medium installer rollback + autoRepair/sandbox mismatch.
- **Bug pass 2:** High dead duplicate-close + auto-repair label burn.

## Notes on incomplete coverage

Bugbot and native Security Review subagents could not run on an even `main` (connection / empty-diff). Coverage was restored via read-only `generalPurpose` substitutes. Thermos concurrency, bug-hunt reproduction, and one auth/trust substitute exhausted without findings — residual race coverage leans on Bug pass 2 and Team/Security passes rather than a dedicated concurrency Thermos.
