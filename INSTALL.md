# Install Codekeeper in a GitHub.com repository

The usual path is the published package. From a clean checkout of the target
repository's default branch:

```bash
npx @coryparry/codekeeper@0.2.0 init
```

You need Node.js 22+, Git, an authenticated current GitHub CLI, and permission
to administer the repository. The installer refuses unsafe repository state. It
creates a setup pull request and never merges it.

The former source-checkout tarball path is retired while Rivet's package release
boundary is established. Follow [Rivet migration authority](docs/RIVET_GH_AW_MIGRATION.md)
for current delivery and qualification gates.

## 1. Run the guided installer

From a clean, current checkout of the target repository's default branch:

```bash
npx @coryparry/codekeeper@0.2.0 init
```

`doctor` runs before configuration and reports repository readiness together:
Node, Git, GitHub CLI authentication, repository admin access, Actions,
checkout state, Git identity, collisions, and organization App caveats. For an
organization repository, an owner or App Manager may be needed to manage the
App, and an owner may still be needed to install it.

Choose **Recommended** for automatic PR review and manual maintenance, with
scheduled maintenance, tracing, repository repair, issue implementation,
duplicate closure, and automatic merge off. Choose **Customize** only when you
need the full policy surface. The final review names enabled triggers,
capabilities, models, validation commands, App authority, and pending remote
changes.

Create an adopter-owned GitHub App when prompted. GitHub pre-fills the required
permissions; do not change them. Install the App only on the selected
repository. Select the downloaded `.pem` file in the installer; do not paste
its contents.

The installer creates and verifies the local commit, pushes the setup branch,
sets secrets and non-startup variables, sets `CODEKEEPER_ENABLED` last, and
opens a setup pull request. Its receipt records completed, pending, and unknown
remote changes without exposing secret values.

After installation, configured owners can post an exact `/codekeeper help`
command to see the commands valid for the current issue, pull request, or review
thread. `/codekeeper defer` is an explicit owner-authorized deferral of one
review thread; ordinary prose, extra text, and unconfigured users never grant
that authority.

## 2. Review before merge

Review the generated policy and callers as you would any privileged automation.
In particular, confirm:

- repository owners, default branch, and automation prefix;
- App repository scope and permissions;
- model providers and any tracing choice;
- automatic triggers and scheduled maintenance state;
- allowed and protected repair paths; and
- at least one repository-specific validation command before enabling a
  code-changing capability.

Codekeeper derives the App registration request from the selected workflows and
capabilities. Contents access is read-only until a code-changing capability is
enabled; issue access is read/write for labels and issue publication; pull
request access is read/write when review or repair publication needs it and
otherwise read-only; metadata remains read-only. These are still real
permissions, so review the exact final authority summary before creating the
App.

## 3. Verify after merge

After the setup PR merges, run the published package command from a clean,
current checkout:

```bash
npx @coryparry/codekeeper@0.2.0 verify
```

`verify` checks the installed catalog, required GitHub setting names, App
identity and scope where the credential can prove them, package acquisition,
and the credential-free policy check. A controlled maintenance dry run is
optional; it cannot prove App publication because dry runs do not mint the App
token.

After a successful install, open a small same-repository pull request against
the default branch and confirm the App-authored summary, labels, and gate
result before requiring the review gate in branch protection. Keep normal
build, test, approval, and deployment checks independently required.

## 4. Supported limits

- GitHub Enterprise Server is unsupported.
- Same-repository, non-draft PRs are supported for review. Non-default stacked
  targets are publication-only: automatic repair and automatic merge remain
  off. Forks, drafts, and merge queues need manual review.
- Persistent shared self-hosted runners are unsupported for installed runtime
  workflows.
- Do not enable code-changing capabilities without a deterministic repository
  validation command beyond `git diff --check`.

See [Authority, data, and cost](docs/authority-data-cost.md) before enabling
providers or mutations, and [SUPPORT.md](SUPPORT.md) for security reporting.
