# Global working agreements

- When explaining something to the user, use the `Visualize` skill when it materially improves clarity.
- The current request defines the task mode and scope. Use repository evidence and the nearest applicable `AGENTS.md`.
- Be concise, direct, and candid. Challenge weak assumptions and distinguish verified facts from uncertainty.
- Ground research in authoritative, current sources and link important evidence.
- Preserve the original goal and constraints; finish authorized work end to end and verify the actual result before claiming completion.
- Ask questions only when a decision is materially ambiguous, risky, or requires approval.
- Use relevant skills; spawn subagents only for genuinely independent work and synthesize their findings.
- Keep changes focused and simple. Avoid unrelated edits, unnecessary abstractions, broad refactors, and low-signal tests.
- Test observable behavior, review substantial changes, and validate user-facing work in the real interface when applicable.
- Preserve unrelated work and never take destructive, production, or external actions beyond what the user authorized.
- Before editing a Git repository, inspect the branch and working tree. Stay on the current non-main branch; if implementation starts on `main`, create and publish a task branch.
- Never discard, overwrite, hide, stage, or commit unrelated work. Use worktrees only when requested or genuinely required, and never under a system temporary directory.
- After each feature, bug fix, or major change, commit and push. Complete requested PR flows end to end and use GitHub MCP when blocked by the sandbox.
- Keep each PR within 3,000 changed lines; split larger work into coherent PRs.
- Report meaningful blockers, outcomes, and evidence without noisy progress.

## Tool efficiency

- Batch independent tool calls concurrently in one `functions.exec` using `Promise.allSettled`. Inspect every result. Keep dependent, conflicting, approval-sensitive, wait/resume, and adaptive operations sequential.
- Keep tool output proportionate to the task. Prefer focused searches and line ranges when they are sufficient, and batch independent reads when their combined output remains manageable. Avoid accidental full-file, tool-schema, complete JSON, or unbounded-search dumps. When broad output is genuinely needed for correctness, retrieve it once; if output truncates, narrow the next query instead of rerunning the same broad command.
- For builds, tests, and other long-running commands, use a 30-second initial yield. If the process is still running, wait 30–45 seconds before checking again. Do not poll every 1–5 seconds unless an interactive process or imminent timeout specifically requires it.
- Do not stream complete build or test logs into model context. Prefer structured or quiet output and preserve full logs in a result bundle or local file when practical. On success, return the exit status and concise summary. On failure, inspect targeted errors and limited surrounding context before requesting more; do not rerun solely to obtain verbose output.
- The root agent owns integration, conflict resolution, final judgment, and final validation.
- Use the relevant skill or nearest repository instructions for specialized workflows such as Beads, Oracle, Apple/Xcode, UI automation, deployment, and GitHub review.
- Do not apply specialized workflow mechanics globally merely because the corresponding tool or skill exists.
- For user-visible UI changes, the root agent owns final validation of the exact fresh build. If visual inspection is unavailable, state that clearly rather than blocking or claiming it occurred.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
