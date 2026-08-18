# CLI control surface

Codekeeper exposes read-only status and authority inspection plus a strict
machine-readable planning path. These commands do not replace the interactive
installer's safety checks.

## Status

```bash
codekeeper status
codekeeper status --json
```

Status reads the installed policy, release manifest, managed workflow set, and
repository variables. It reports:

- exact installed package identity and source receipt;
- whether `CODEKEEPER_ENABLED` is true;
- configured owners, workflows, models, providers, and workspaces;
- effective GitHub App permissions and capability switches;
- tracing, scheduled maintenance, validation commands, and finite policy
  budgets; and
- the names of required secrets, never their values.

Status does not call a model or mutate GitHub.

## Explain authority

```bash
codekeeper explain
codekeeper explain --capability repair
codekeeper explain --json
```

Explain turns the installed policy into a bounded authority report. A selected
capability shows whether it is enabled and what GitHub action it can authorize.
The report also names automatic triggers, model providers, tracing, validation
commands, and budgets.

## Noninteractive plan

```bash
codekeeper plan --config codekeeper.setup.json --package-integrity 'sha512-...'
codekeeper plan --config codekeeper.setup.json --json
```

The configuration file:

- must be a regular non-symlink JSON file no larger than 1 MiB;
- has `version: 1` and rejects unknown fields;
- may select modes, models, capabilities, owners, App identity, validation,
  startup, tracing, and scheduling;
- rejects credential-shaped fields and private-key text at every nesting
  level; and
- is passed through the same preflight, policy, asset, permission, and install
  plan builders used by the interactive CLI.

The JSON result hashes repository-variable values and includes only secret
names and purposes. It contains no secret values.

Applying a reviewed plan is deliberately double-gated:

```bash
CODEKEEPER_NONINTERACTIVE_APPLY=true \
  codekeeper plan --config codekeeper.setup.json \
  --package-integrity 'sha512-...' --apply
```

Apply mode re-inspects repository and setting state immediately before
mutation. It refuses any plan that requires secret entry; use the interactive
installer for those changes. A successful apply can create a setup or update
pull request, but it never merges it.

## Example configuration

```json
{
  "version": 1,
  "displayName": "Example repository",
  "ownerLogins": ["example-owner"],
  "modes": ["review", "maintain"],
  "preset": "openai",
  "capabilities": [],
  "tracing": false,
  "maintenanceScheduled": false,
  "enabled": true,
  "appClientId": "Iv1.EXAMPLECLIENTIDVALUE",
  "automationBotLogin": "example-codekeeper[bot]"
}
```

Do not add API keys, App private keys, tokens, passwords, or credential values
to this file.
