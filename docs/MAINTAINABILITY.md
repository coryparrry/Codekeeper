# Maintainability boundaries

Rivet bounds the active package and repository scripts so new monoliths and
local import cycles fail the repository checks. The authoritative limits live
in [`scripts/module-boundaries.json`](../scripts/module-boundaries.json).

## Limits

| Kind                     | Line limit | Byte limit |
| ------------------------ | ---------: | ---------: |
| Implementation module    |        800 |     40,000 |
| Test file (`*.test.mjs`) |      1,000 |     60,000 |

The checker covers ES modules under `packages/rivet/src`,
`packages/rivet/test`, and `scripts`. It rejects oversized files, unsafe or
duplicate roots, symlinks, missing local imports, and cycles in the local import
graph.

There are no current legacy size exemptions or compatibility facades. If a
temporary legacy ceiling becomes necessary, it must record the existing line
and byte limits. The file may shrink but cannot grow, and the exemption must be
removed once the file fits the normal limits.

## Current seams

- `packages/rivet/src/cli.mjs` parses the public commands and routes bare
  `rivet init` to the guided review-only installer.
- `guided-init.mjs`, `app-authority.mjs`, `app-setup.mjs`, and `setup-pr.mjs`
  own guided setup, App permission verification, encrypted secret storage, and
  the verified draft setup pull request.
- `install.mjs` owns the installation plan and file application. Narrow upgrade
  modules recognize exact historical Rivet installations without weakening
  modified-file checks.
- `workflows/*.mjs` render the supported review, issue-triage, repair, and
  maintenance workflows. `workflow-files.mjs` maps those renderers to managed
  adopter paths.
- `gh-aw/*.mjs` owns the pinned compiler receipt, compilation, and authority
  inspection. Managed agent and action sources live under
  `packages/rivet/assets`.

Historical upgrade inputs under `packages/rivet/assets/upgrades` and test
fixtures are compatibility evidence. They are not active runtime entrypoints.

## Check

```bash
npm run architecture:check
```

The root `npm run check` command includes this gate.
