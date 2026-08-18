# Installer recovery and removal

Codekeeper treats recovery and removal as explicit repository state machines.
Neither command merges a pull request.

## Resume an interrupted installation

Use `resume` only after the installer has already pushed a setup or update
branch:

```bash
codekeeper resume
codekeeper resume --branch codekeeper/setup
codekeeper resume --json
```

The default command is read-only. It proves:

- the checkout belongs to the same GitHub.com repository;
- exactly one eligible remote setup or update branch exists, unless
  `--branch` selects one;
- the branch tip does not move during inspection;
- the branch contains readable Codekeeper policy and release manifests;
- any existing pull request targets the default branch at the exact remote SHA;
- required secret names and repository-variable names exist.

GitHub does not allow secret values to be read back. A secret name appearing in
the repository is availability evidence, not proof of its value.

Apply only the bounded reconciliation actions with:

```bash
codekeeper resume --apply
```

Apply mode may create a missing pull request and set a missing
`CODEKEEPER_ENABLED` variable to `false`. It does not replace secrets, invent a
GitHub App client ID or bot login, modify the pushed commit, or enable
Codekeeper.

## Remove an installation

Inspect the exact removal plan first:

```bash
codekeeper remove
codekeeper remove --json
```

Planning requires a clean checkout whose `HEAD` exactly matches the remote
GitHub default branch. Codekeeper reads `.github/codekeeper-release.json` and
requires every managed file to:

- use a safe repository-relative path;
- be a regular non-symlink file; and
- match the release-recorded SHA-256.

Apply the reviewed plan with:

```bash
codekeeper remove --apply
```

Apply mode:

1. sets `CODEKEEPER_ENABLED=false`;
2. creates `codekeeper/remove-<head-sha>`;
3. deletes only the verified release-owned files;
4. verifies the exact staged and committed path inventory;
5. pushes the exact commit; and
6. opens a removal pull request.

It does not merge the pull request. It also preserves repository secrets,
variables, labels, and the adopter-owned GitHub App installation. Remove those
only after the deletion pull request merges and after checking that no other
workflow uses them.

## Failure recovery

If a removal push succeeds but pull-request creation fails, inspect the printed
branch and use the displayed `gh pr list` recovery command. Do not rerun removal
from a changed default branch.

If recovery reports more than one setup/update branch, select one explicitly.
Do not guess which branch is authoritative.
