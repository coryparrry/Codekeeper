# Whole-Repository Adversarial Hardening Triage

**Source report:** `2026-08-11-whole-repo-hardening-report.md` from checkout `8f36d51`
**Triaged revision:** `8246e6f78abdf172f37c92358b32d867ec3026cc`
**Execution branch:** `codex/whole-repo-hardening-fixes`
**Approval:** the requester explicitly authorized every legitimate finding for immediate remediation.

## Outcome

The report contained 23 adversarial assertions. Twenty-one reproduced against the live PR head and were accepted as **Fix now**. Two were already corrected between the audited checkout and the live head and are **Ignore — stale/already fixed**. The remaining complexity notes were heuristic observations rather than demonstrated defects; only the proven acceptance polling amplification was included in this remediation.

No report assertion remains pending.

| Classification | Count | Outcome |
|---|---:|---|
| Fix now | 21 | Remediated with retained regression coverage |
| Ignore — stale/already fixed | 2 | Verified green before this branch changed production code |
| Ignore — unproven heuristic | 1 group | No broad refactor based only on file size or possible N+1 shapes |
| Defer / Needs clarification | 0 | None |

## Accepted findings

| Area | Legitimacy evidence | Remediation |
|---|---|---|
| Validation and provider deadlines | Both deliberately unsettled operations exceeded the audit deadline on the live head. | Added finite production budgets, child termination for validation commands, and an abortable provider-turn deadline. |
| Automatic repair retry marker | A failed dispatch left `codekeeper:auto-repaired` behind and suppressed the next retry. | Dispatch is transactional with marker rollback; rollback failures are surfaced. |
| Policy repair revocation | Removing the one-shot marker after preparation did not revoke a policy-authorized repair. | Live repair revalidation requires the marker for policy mode while preserving explicit owner mode. |
| Secret text entry | The first ordinary keystroke was committed as the complete secret. | Secret entry accepts bracketed paste and explicit submission without committing partial ordinary input. |
| Stale picker activation | A delayed activation from a replaced screen could settle the new screen. | Picker settlements are bound to the screen generation that created them. |
| Secret upload deadline | Three `gh secret set` paths explicitly disabled command timeouts. | All secret uploads use a finite five-minute command budget. |
| Manual acceptance freshness | Review and issue verification accepted an explicit run without a trigger-time lower bound. | Both commands require `--run-created-after ISO-8601` and reject runs created before it. |
| Acceptance run inventory | Quiescence inspected at most 100 runs and polling made one metadata request per baseline run per poll. | The harness requests 1,000 runs plus an overflow sentinel, fails closed on incomplete enumeration, and revalidates baseline state from each bounded list snapshot. |
| Remote audit base | Publication relied on local `HEAD` immediately before a GitHub mutation. | The remote default-branch SHA is re-read at each audit mutation boundary. |
| GitHub pagination trust | Pagination accepted arbitrary next-link origins and could cycle forever. | Next links must remain under the configured API origin/path; repeated URLs and excessive page counts fail closed. |
| Duplicate issue closure | Codekeeper's own marker comment invalidated its stale `updated_at` precondition. | The expected timestamp is rebased only after proving subject and labels did not change. |
| Owner command pause rollback | A failed repair dispatch could leave a previously paused target unpaused. | Unpause and dispatch now form a rollback-protected operation. |
| Owner PR triage eligibility | Draft, forked, or retargeted PRs could reach dispatch. | Review and triage commands share the live same-repository, non-draft, default-branch eligibility gate. |
| Live review state | Publication did not reject a PR that became draft or paused after preparation. | Current review publication revalidates both states. |
| Unknown CLI flags | A misspelled safety flag was ignored while live mode remained the default. | The CLI rejects every flag outside its explicit command-wide allowlist before loading configuration or acting. |
| Validation credential inheritance | Provider-like environment variables outside a finite denylist reached validation children. | Validation starts from a filtered environment and removes explicit credentials plus credential-shaped names. |
| Workflow-command injection | Newlines in error values could create a second GitHub workflow command. | Workflow command values escape `%`, carriage return, and newline. |
| Private-key picker bound | Directory enumeration was unbounded and metadata probes were sequential. | Enumeration is capped at 1,000 entries and metadata probes use bounded concurrency. |
| Workspace capture bound | Oversized untracked files and diffs were materialized before repair-policy limits were checked. | Capture receives the repair limits, skips oversized content before reading it, and bounds diff output. |

## Stale findings ignored

| Report assertion | Current-head evidence | Classification |
|---|---|---|
| Repository-dispatch fix target differed between `workspace` and `analyze`. | At `8246e6f`, both expressions already include `github.event.client_payload.number`; the imported adversarial assertion passed before this branch changed the workflow. | Ignore — stale/already fixed |
| Automatic review repair omitted policy authorization metadata. | At `8246e6f`, the dispatch payload already includes `authorization_mode: policy` and `requested_by`; the imported assertion passed before production edits. | Ignore — stale/already fixed |

## Heuristic observations

The report's file-length, possible maintenance-scan repetition, and possible review-reply N+1 notes do not include a failing behavioral proof or a bounded change brief. They are not treated as defects in this pass. The proven acceptance `B × P` remote-request amplification was fixed because its call path and bound were concrete.

## Retained evidence

The ten imported adversarial files are retained under `tools/codekeeper/audit`, `packages/codekeeper/audit`, and `acceptance/audit`. Each package's `test` and `check` scripts now execute them with the normal regression suite.

Focused post-fix evidence:

- tools runtime and boundary probes: 8/8 pass;
- tools commands, publication, workflow, and remote-base probes: 9/9 pass;
- installer and TUI probes: 4/4 pass;
- acceptance probes and harness suite: 29/29 pass;
- installer/TUI normal suite: 170/170 pass.

Full repository verification is recorded in the branch/PR handoff after the generated tooling and release provenance are refreshed.
