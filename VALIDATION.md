# Validation

Run these checks before publishing a source release or changing reusable workflows:

```bash
node tools/ai-maintainer/src/cli.mjs check-config
cd tools/ai-maintainer && npm test
find src test -name '*.mjs' -print0 | xargs -0 -n1 node --check
```

The repository workflow also runs the Node test suite, Actionlint, and YAML parsing when maintainer workflows, caller templates, or tooling change.

The tests cover structured output, configured-owner triage and fix authorization, policy and label ownership, prompt/context handling, artifact sealing, patch limits, fresh-checkout verification, current PR identity, App-owned markers, auto-merge eligibility, and reusable-workflow contracts.

These local checks do not prove an adopter installation. Before enabling writes, run the maintenance workflow with `dry_run=true`, then verify a same-repository default-branch PR using the adopter's GitHub App, secrets, branch rules, and path policy. Confirm the review caller is evaluated from its default-branch `pull_request_target` definition and never checks out or executes PR code. Forks, merge queues, non-default PR targets, and GitHub Enterprise Server are outside the supported surface.
