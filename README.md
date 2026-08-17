# Codekeeper

Codekeeper gives a repository a deliberately bounded GitHub Actions maintainer:

- a living pull-request review summary and gate;
- issue triage with explicit duplicate and readiness decisions;
- manual maintenance audits, with an explicit dry-run mode; and
- small, policy-checked repairs only when a maintainer enables them.

It is not a hosted service. Each adopter owns its GitHub App, GitHub Actions
usage, model-provider account, policy, and credentials.

> **Install status:** `codekeeper@0.2.0` was not available from npm when
> checked on 2026-08-17 (`npm view` returned `E404`). Until a public release is
> announced, use the source/local-tarball evaluation path in
> [INSTALL.md](INSTALL.md). Do not use an `npx codekeeper@0.2.0` command as an
> installation instruction.

## Who it is for

Codekeeper is a good fit for a GitHub.com repository whose maintainers want a
reviewable policy boundary around AI-assisted review and repair, can supply
deterministic validation commands before enabling code changes, and are
comfortable owning a GitHub App and model-provider billing.

It is not yet a good fit for public projects that need fork PR reviews,
merge-queue review gates, persistent self-hosted runners,
one-click hosted onboarding, or an independently published quality benchmark.
Those are active hardening and product-evidence priorities, not supported
claims.

## Start safely

1. Read [INSTALL.md](INSTALL.md) and create a local package tarball from a
   clean source checkout.
2. Run the installer from a clean checkout of a private or same-repository
   evaluation target. It creates a setup pull request; it does not merge it.
   Until the package is published, this is installer evaluation rather than a
   working runtime installation.
3. On the recommended path, automatic PR review is on after merge; scheduled
   maintenance, tracing, repository repair, issue implementation, duplicate
   closure, and automatic merge are off.
4. After merge, run `codekeeper verify`, then prove one controlled
   same-repository PR before making its gate required.

An opened setup pull request is not proof that Codekeeper works. After a public
package release, the final runtime proof is installed verification plus the
selected workflow's observed GitHub result. The current npm E404 prevents that
proof boundary.

## What it can do

| Role | Initial authority | Requires explicit opt-in |
|---|---|---|
| PR reviewer | Publish App-owned summary, labels, and gate output for supported PRs. | Automatic repair and merge. |
| Issue triager | Publish one App-owned triage comment and labels. | Exact-duplicate closure and issue implementation. |
| Repository auditor | Run manually; a live run may publish bounded maintenance issues. | Scheduled runs and repair. Use `dry_run=true` for a report-only audit. |
| Fixer | No automatic source change by default. | An eligible, bounded repair after policy validation. |

The starter policy is a starting point, not a safe configuration for every
repository. Review its owners, branch, path limits, labels, and validation
commands before merge.

## Trust boundary

Codekeeper keeps repository inspection, model reasoning, deterministic
validation, sealing, and GitHub publication separate. The workspace specialist
does not receive the GitHub App credential; publication does not execute
repository code or receive model-provider credentials. Every mutation is
checked against the frozen policy and current GitHub state.

See [Authority, data, and cost](docs/authority-data-cost.md) before enabling a
model or code-changing capability, and [ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the detailed pipeline.

## Supported surface

- GitHub.com only; GitHub Enterprise Server is unsupported.
- Same-repository, non-draft pull requests may be reviewed. Stacked targets are
  publication-only: automatic repair and automatic merge stay off.
- The v1 caller does not supply a merge-queue gate.
- Repairs require a repository-specific deterministic validation command in
  addition to structural patch checks.
- Use GitHub-hosted ephemeral runners for installed workflows. Persistent
  shared self-hosted runners are outside the supported trust boundary.

## Owner commands

Configured owners can use exact complete-body slash commands such as
`/codekeeper help`, `/codekeeper review`, `/codekeeper status`, and
`/codekeeper pause`. Compatibility aliases such as `/codekeeper stop` remain
accepted. The same
commands can mention the installed App as `@<app-slug> review` or
`@<app-slug>[bot] review`. Ordinary prose and unconfigured users do not grant
authority. Free-form requests such as `@<app-slug> please review this` are ignored.

## Documentation

| Document | Use it for |
|---|---|
| [Installation](INSTALL.md) | Local package evaluation, GitHub App setup, and proof after merge. |
| [Configuration](docs/CONFIGURATION.md) | Policy, models, triggers, and capability controls. |
| [Authority, data, and cost](docs/authority-data-cost.md) | What Codekeeper can change, what reaches providers, and cost levers. |
| [Architecture](docs/ARCHITECTURE.md) | Runtime and credential boundaries. |
| [Evaluations](docs/EVALUATIONS.md) | Evaluation method and its current evidence boundary. |
| [Documentation index](docs/README.md) | Full documentation map. |
| [Roadmap](ROADMAP.md) | Product priorities; not a delivery promise. |
| [Support](SUPPORT.md) | Questions, bugs, and security reporting. |

## Develop from source

```bash
env npm_config_cache=/tmp/codekeeper-npm-cache npm ci --ignore-scripts --no-audit --no-fund
npm run check
node tools/codekeeper/src/cli.mjs check-config
cd tools/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
cd ../../packages/codekeeper && npm ci --ignore-scripts --no-audit --no-fund && npm run check
```

Use [CONTRIBUTING.md](CONTRIBUTING.md) for change and test expectations. Source
releases are verified with `bash scripts/release-source.sh --verify`; that
proves source integrity, not registry publication or a live adopter run.

## License

Apache-2.0. See [LICENSE](LICENSE).
