# Repository governance

Codekeeper's source and release authority are protected by two repository rulesets
defined in [`.github/repository-rules.json`](../.github/repository-rules.json).

The file is the reviewable source of truth. Merging it does **not** change GitHub
settings. An administrator must deliberately apply it after the pull request has
merged.

## Protected delivery branch

The branch ruleset protects `main`. It:

- requires changes to arrive through pull requests;
- requires one approving review and dismisses that approval when new commits are pushed;
- routes ownership through `CODEOWNERS` without making the pull-request author
  the only eligible approver;
- requires all package, runtime, and acceptance jobs from
  `Codekeeper checks`;
- requires review conversations to be resolved;
- allows repository administrators to bypass pull-request rules only, so a
  sole-maintainer repository is not permanently locked; direct pushes, tag
  mutation, branch deletion, and force pushes are not bypassed;
- blocks branch deletion; and
- blocks force pushes.

Contributors cannot approve their own pull requests. Feature branches and Release
Please branches both open pull requests directly against `main` and require the
same independent approval and checks. While the repository has only one
maintainer, that administrator can deliberately use the pull-request-only bypass
after all checks pass; contributor roles cannot use it.

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
release evidence.
