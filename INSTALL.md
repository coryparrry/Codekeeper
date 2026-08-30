# Install Rivet in a GitHub.com repository

Use the published [`@coryparry/rivet`](https://www.npmjs.com/package/@coryparry/rivet)
package from an existing repository checkout. Rivet supports Node.js 22 or
newer and requires Git plus an authenticated
[GitHub CLI](https://cli.github.com/). Repository administration permission is
required to configure and install the GitHub App.

The former Codekeeper package and source-checkout tarball flows are retired.
They remain documented only as migration history; new installations use Rivet.

## 1. Plan the review-only App

Generate the minimum review authority and a private, webhook-free GitHub App
registration URL:

```bash
npx --yes @coryparry/rivet app-plan --repository OWNER/REPOSITORY
```

For an organization-owned App, add `--owner-type Organization`. Open the
returned URL, create the App, and download its private key. Keep the generated
permissions unchanged and install the App only on the selected repository.

## 2. Configure and verify App authority

Configure the repository variables and private-key secret:

```bash
npx --yes @coryparry/rivet app-configure \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

Rivet authenticates the key before it changes repository metadata, sends the
private key to `gh secret set` over standard input, and returns the App
installation URL. After installing the App on the selected repository, verify
its live identity and least-privilege scope:

```bash
npx --yes @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

The review-only App requires Contents read, Metadata read, Pull requests write,
Issues write for automatic triage, and no webhook events or additional
repository permissions. The private key is stored as `RIVET_APP_PRIVATE_KEY`;
the verified client ID and App bot login are stored as repository variables.

## 3. Configure model access

The shipped workflow uses the `codex` engine with `gpt-5.6-luna`. Store one of
its accepted provider credentials as a repository Actions secret:

```bash
gh secret set CODEX_API_KEY --repo OWNER/REPOSITORY
```

Enter the value only when the GitHub CLI reads it securely; do not put the key
in the command, repository, setup pull request, or logs. `OPENAI_API_KEY` is an
accepted alternative. `rivet app-configure` sets only the Rivet App variables
and private-key secret, and `rivet init` does not set provider credentials.

## 4. Preview and install review-only mode

Preview the exact managed plan without writing to the checkout:

```bash
npx --yes @coryparry/rivet init --review-only \
  --repository /path/to/repository \
  --dry-run
```

The repository path must already exist. Rivet stages, compiles, and validates
the managed files before checking every destination for collisions or drift.

The recommended installation path is a draft setup pull request. Start from a
clean checkout whose `HEAD` exactly matches the fetched remote default branch:

```bash
npx --yes @coryparry/rivet init --review-only \
  --repository /path/to/repository \
  --setup-pr
```

Rivet creates `rivet/setup-review` by default. It commits only managed paths,
pushes the exact commit, opens a draft pull request, and verifies the pull
request's base, head, commit, draft state, and URL. It never merges the pull
request. Use `--setup-branch <name>` to choose another unused branch.

Without `--dry-run` or `--setup-pr`, `rivet init` applies the verified plan
directly to the existing checkout. It still refuses adopter-owned collisions
and rechecks managed destinations immediately before writing.

## 5. Prove the first live review

Review and merge the setup pull request through the repository's normal
controls. Then open a small, same-repository, non-draft pull request against the
default branch. A successful Rivet App-authored review is the final proof that
GitHub can mint an installation token from the stored credentials.

Keep Rivet's review result optional in branch protection until this live proof
succeeds. Existing build, test, approval, security, and deployment gates remain
independently required.

## 6. Enable owner-authorized repair

Repair is a separate authority upgrade. In GitHub, widen only the Rivet App's
Contents permission from read to write. Then verify the exact repair scope:

```bash
npx --yes @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem \
  --repair
```

Preview the repair upgrade:

```bash
npx --yes @coryparry/rivet init --repair \
  --repository /path/to/repository \
  --dry-run
```

Replace `--dry-run` with `--setup-pr` to create the draft upgrade pull request
on `rivet/setup-repair` by default. After that pull request merges, a repository
administrator can post the exact `/rivet-repair` command on an eligible pull
request. Rivet validates the proposed patch without write credentials on an
isolated runner before a separate App-authenticated job may publish the exact
validated artifact. It never merges.

## Supported limits

- GitHub Enterprise Server is unsupported.
- Review supports same-repository, non-draft pull requests.
- Issue implementation, maintenance, and merge remain disabled in the shipped
  configuration.
- Persistent shared self-hosted runners are outside the supported trust
  boundary.
- Repair must use repository-specific deterministic validation commands; the
  shipped fallback is only a starting point to review before enabling repair.

See [Rivet GitHub App authority](docs/RIVET_GITHUB_APP_AUTHORITY.md),
[Rivet installer contract](docs/RIVET_REVIEW_ONLY_INSTALLER.md), and
[Rivet repair qualification](docs/RIVET_REPAIR_QUALIFICATION.md) for the full
security and evidence boundaries.
