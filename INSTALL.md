# Install Codekeeper in a GitHub.com repository

## Current availability

Codekeeper is currently evaluated from a local, verified tarball. On
2026-08-17, `npm view codekeeper@0.2.0` returned `E404`; there is no public npm
installation command to copy from this document. A future release must publish
its exact version, integrity, provenance, and release notes before an npm
command is documented here.

This guide is for experienced maintainers evaluating the source checkout on a
private or same-repository target. It requires Node.js 22+, Git, and an
authenticated current GitHub CLI. The installer refuses unsafe repository
state; it creates a setup pull request and never merges it. Its generated
runtime workflows acquire the pinned package from npm, so the current E404
prevents a local installer test from becoming a proven live installation.

## 1. Build an exact local package

From a clean source checkout, make a tarball outside that checkout and retain
the integrity returned by the same pack operation:

```bash
PACKAGE_DESTINATION=/absolute/path/outside/source-checkout/codekeeper-dist
mkdir -p "$PACKAGE_DESTINATION"
npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund
PACK_REPORT="$(npm run --silent package:pack -- --destination "$PACKAGE_DESTINATION")"
PACKAGE_FILE="$(node -e '
const report = JSON.parse(process.argv[1]);
const reports = Array.isArray(report)
  ? report
  : report && typeof report === "object"
    ? Object.hasOwn(report, "filename") || Object.hasOwn(report, "integrity") ? [report] : Object.values(report)
    : [];
if (reports.length !== 1) throw new Error("npm pack must return exactly one report");
const [entry] = reports;
if (!entry || typeof entry !== "object" || typeof entry.filename !== "string" || typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) throw new Error("npm pack returned an invalid report");
process.stdout.write(entry.filename);
' "$PACK_REPORT")"
PACKAGE_INTEGRITY="$(node -e '
const report = JSON.parse(process.argv[1]);
const reports = Array.isArray(report)
  ? report
  : report && typeof report === "object"
    ? Object.hasOwn(report, "filename") || Object.hasOwn(report, "integrity") ? [report] : Object.values(report)
    : [];
if (reports.length !== 1) throw new Error("npm pack must return exactly one report");
const [entry] = reports;
if (!entry || typeof entry !== "object" || typeof entry.filename !== "string" || typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) throw new Error("npm pack returned an invalid report");
process.stdout.write(entry.integrity);
' "$PACK_REPORT")"
```

The pack command enforces the repository's pinned npm version and release
snapshot checks. Treat the local package and its receipt as one pair; do not
substitute an integrity value from another file or registry response.

## 2. Run the guided installer

From a clean, current checkout of the target repository's default branch:

```bash
npm exec --package "$PACKAGE_DESTINATION/$PACKAGE_FILE" -- \
  codekeeper init --current-package --package-integrity "$PACKAGE_INTEGRITY"
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

## 3. Review before merge

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

## 4. Record the current proof boundary

After the setup PR merges, run the same local package command from a clean,
current checkout:

```bash
npm exec --package "$PACKAGE_DESTINATION/$PACKAGE_FILE" -- \
  codekeeper verify
```

After a public package release, `verify` checks the installed catalog, required
GitHub setting names, App identity and scope where the credential can prove
them, package acquisition, and the credential-free policy check. A controlled
maintenance dry run is optional; it cannot prove App publication because dry
runs do not mint the App token.

At the current E404 boundary, this command cannot prove package acquisition or
a live workflow. Treat that as an expected release blocker, not a successful
installation. Do not make the review gate required or enable scheduled or
code-changing automation from this local setup alone.

After the package is available, open a small same-repository pull request
against the default branch and confirm the App-authored summary, labels, and
gate result before requiring the review gate in branch protection. Keep normal
build, test, approval, and deployment checks independently required.

## Manual installation and recovery

The local tarball installer is the supported evaluation path. Manual copying of
workflows is useful only for audit or recovery and has more provenance and
update risk. If it is unavoidable, copy the policy, selected caller templates,
matching reusable workflows, and package-acquisition action together; pin every
caller to the exact local package version and SHA-512 receipt. Never copy a
source commit, an unverified tarball, or a package integrity from a different
build into an adopter repository.

## Supported limits

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
