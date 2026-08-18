# Repository governance

Codekeeper's source and release authority are protected by two repository rulesets
defined in [`.github/repository-rules.json`](../.github/repository-rules.json).

The file is the reviewable source of truth. Merging it does **not** change GitHub
settings. An administrator must deliberately apply it after the pull request has
merged.

## Protected default branch

The `main` ruleset:

- requires changes to arrive through pull requests;
- requires all four jobs from `Codekeeper checks`;
- requires review conversations to be resolved;
- blocks branch deletion; and
- blocks force pushes.

Codekeeper is currently a solo-maintainer repository, so the checked-in contract
does not require a second approval or a code-owner approval. `CODEOWNERS` still
routes ownership and protects the governance files. Increase the approval count
only after another trusted reviewer has write access, otherwise the repository
owner can be locked out of normal maintenance.

## Immutable release tags

The `codekeeper-v*` tag ruleset blocks updates and deletion after a tag is
created. Release creation remains allowed; changing an existing release tag does
not.

## Validate, inspect, and apply

Local validation is credential-free:

```bash
npm run governance:check
```

Inspect the live repository without mutation:

```bash
node scripts/repository-governance.mjs --check-remote
```

Applying settings is deliberately double-gated and is never performed by normal
CI:

```bash
CODEKEEPER_GOVERNANCE_APPLY=true \
  node scripts/repository-governance.mjs --apply
```

The command requires an authenticated GitHub CLI with repository administration
write permission. It creates missing rulesets and updates only rulesets whose
names exactly match this repository-owned contract. It does not delete unrelated
rulesets.

After applying, run `--check-remote` again and retain the command output with the
release-readiness evidence.
