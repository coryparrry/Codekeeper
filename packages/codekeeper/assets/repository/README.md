# Codekeeper installation

This installation includes Codekeeper's repository policy and optional agent-profile overrides.

- `../codekeeper.json` is editable configuration with release-owned safety boundaries.
- `agents/*.md` files are optional repository overrides. When an override is absent, the exact packaged agent profile is used.
- This file is release-owned. `codekeeper update` refreshes it with the rest of the installed release.

Run `codekeeper init` to edit configuration. Run `codekeeper update` to review and install a newer Codekeeper release through a pull request.
