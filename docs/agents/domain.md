# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** if it exists.
- **`docs/adr/`** for decisions touching the area being changed.

If these files do not exist, proceed silently. Domain-modeling skills create them lazily when terms or decisions are resolved.

## File structure

This repository uses the single-context layout:

```
/
├── CONTEXT.md
├── docs/adr/
└── packages/
```

## Use the glossary's vocabulary

Use domain concepts as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is missing, reconsider whether it belongs or note the gap for domain modeling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
