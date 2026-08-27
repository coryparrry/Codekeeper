# Rivet GitHub App authority

Rivet review workflows authenticate GitHub operations with short-lived installation tokens. The workflow never stores an installation token as a secret.

## Review-only authority

The review-only App requires:

- Contents: read
- Metadata: read
- Pull requests: write
- Webhooks: disabled

Pull-request write access is required for bounded inline findings and the final review. Repair, issue, maintenance, contents-write, and merge authority remain disabled.

Rivet expects the repository variable `RIVET_APP_CLIENT_ID` and repository secret `RIVET_APP_PRIVATE_KEY`. The pinned gh-aw compiler uses those credentials to generate immutable `actions/create-github-app-token` steps for activation and safe outputs. Missing credentials fail token minting; Rivet does not fall back to a differently named legacy App credential.

## Registration plan

Generate a private, webhook-free registration URL and the exact authority summary with:

```bash
rivet app-plan --repository OWNER/REPOSITORY
```

For an organization-owned App, add `--owner-type Organization`. The command is read-only and never creates or installs the App.

## Current boundary

The review installer records this authority in `.github/rivet/installation.json`, and the generated workflow is ready to mint App tokens. This layer does not upload the PEM, set the client-ID variable, install the App, or verify its effective repository permissions. Those GitHub mutations require explicit human-controlled setup and live verification before the setup PR can be called operational.
