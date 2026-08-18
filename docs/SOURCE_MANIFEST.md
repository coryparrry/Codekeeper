# Source manifest overlays

`MANIFEST.sha256` is the immutable baseline inventory for Codekeeper source
releases. Later stacked changes record only their changed and newly tracked
paths in `MANIFEST.overrides.sha256`.

The verifier applies the override manifest after the baseline, then requires
the resulting path set to match the complete tracked source inventory exactly.
An override can replace a stale baseline digest or add a new path; it cannot
remove inventory, contain duplicate or unsafe paths, hash either manifest
control file, or point to a symlink or non-regular file.

This keeps stacked pull requests reviewable without weakening release evidence:

- unchanged baseline bytes remain stable;
- every changed path still has one exact SHA-256 digest;
- missing and extra source files fail closed;
- archives and working trees use the same verifier; and
- the override file is excluded from its own recursive checksum contract.

When changing tracked files, update the override file with the final content
digest. Do not edit old baseline entries merely to make a check pass. A future
release may compact the effective map into a new reviewed baseline, but the
compaction must preserve the exact resolved inventory.
