# Rivet GitHub App authority

Rivet review workflows authenticate GitHub operations with short-lived installation tokens. The workflow never stores an installation token as a secret.

## Review authority

The default guided review installation, which includes automatic issue triage,
requires exactly:

- Contents: read
- Issues: write
- Metadata: read
- Pull requests: write
- Webhooks: disabled

Pull-request write access is required for bounded inline findings, the final
review, and reconciliation of Rivet's managed status and missing-test labels.
Repair, issue implementation, contents-write, and merge authority remain
disabled. Report-only maintenance uses no App permission and cannot publish an
issue, pull request, comment, commit, label, or merge.

## Optional issue authority

Issues write is conditional on `issues.triage` being `automatic`. Rivet uses
that permission for two distinct bounded actions:

- Incoming triage may publish one App-authored state on a newly opened issue,
  then a new state after an authorized reporter or collaborator follow-up.
- Pull-request review may defer at most one verified, out-of-scope finding to a
  new issue.

Neither action may label or close an issue, implement a fix, open a pull
request, or merge. When triage is `disabled`, Rivet installs no incoming issue
workflow, review cannot create a deferred issue, and the exact review plan omits
Issues permission.

Adding Issues: write to an existing App installation can require explicit
approval from a GitHub administrator. The workflow is not operational until
GitHub applies that permission change.

Rivet expects the repository variables `RIVET_APP_CLIENT_ID` and
`RIVET_APP_BOT_LOGIN` plus the repository secret `RIVET_APP_PRIVATE_KEY`. The
bot-login variable names the verified App slug and permits that App to trigger
the review that follows a repair. The pinned gh-aw compiler uses the credentials
to generate immutable `actions/create-github-app-token` steps for activation,
pending and final managed-label publication, and safe outputs. Missing
credentials fail token minting; Rivet does not fall back to differently named
legacy App credentials.

## Registration plan

Generate a private, webhook-free registration URL and the exact authority summary with:

```bash
npx @coryparry/rivet app-plan --repository OWNER/REPOSITORY
```

For an organization-owned App, add `--owner-type Organization`. The command is
read-only and never creates or installs the App. It returns a GitHub.com URL
whose form is prefilled with the selected repository website, a private App,
disabled webhooks, and the exact permissions. An administrator must create the
App on that page, download its private-key PEM, and install it manually.

## Configure repository credentials

After creating the App and downloading its private key, configure one repository:

```bash
npx @coryparry/rivet app-configure \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

Rivet authenticates the key against GitHub before changing repository metadata.
It sets `RIVET_APP_CLIENT_ID` and the verified App slug in
`RIVET_APP_BOT_LOGIN`, then sends the private key to `gh secret set` over
standard input. The key is never placed in command arguments or output. Paths
beginning with `~/` are supported. The reader accepts only a bounded regular
file, refuses symlinks where the platform supports that check, detects a file
that changes while being read, and validates the private key before use. The
command returns the App installation URL; a repository administrator must use
it to install the App on only the selected repository.

Do not reuse legacy Codekeeper credential names. Rivet intentionally has no fallback to them.

## Verify effective authority

After installation, verify the live App and repository configuration:

```bash
npx @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

Owner-authorized repair requires one explicit authority widening. After GitHub
shows and applies the Contents permission change from read to write, verify the
exact repair scope before enabling the repair workflow. Issues remains write
only when automatic triage is enabled; Metadata read and Pull requests write
are unchanged:

```bash
npx @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem \
  --repair
```

The repair verifier rejects selected-repository drift, events, extra or missing
permissions, missing credential metadata, and any Contents permission other
than write. Passing this command verifies authority only. Enable the verified
repair workflow and assets with `npx @coryparry/rivet init --repair`, preferably
through its `--setup-pr` path.

Verification fails unless all of these conditions hold:

- the key authenticates as the App identified by the supplied client ID;
- the installation targets selected repositories rather than all repositories;
- effective permissions are exactly the selected review or repair plan;
- no webhook events or additional permissions are enabled;
- the repository variable contains the supplied client ID; and
- the repository secret exists under the Rivet name.

GitHub does not expose a stored secret value, so this command proves the secret's metadata but cannot compare its contents with the local key. A successful review workflow run is the final proof that GitHub can mint an installation token from the stored credentials.

## Operational boundary

The review installer records this authority in `.github/rivet/installation.json`, and the generated workflow is ready to mint App tokens. App creation and installation remain human-controlled GitHub operations. The setup is operational only after `app-verify` succeeds and a review workflow mints a token in the selected repository.

Bare guided init performs configuration and verification in that order, then
creates a verified draft setup pull request. The user must review it, mark it
ready, and merge it through the repository's normal controls before the
workflow is active. Rivet never merges the setup pull request.
