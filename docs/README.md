# Codekeeper documentation

The product is migrating to Rivet. The migration authority and delivery gates
are defined in [RIVET_GH_AW_MIGRATION.md](RIVET_GH_AW_MIGRATION.md), with the
legacy comparison checkpoint in
[RIVET_LEGACY_BASELINE.md](RIVET_LEGACY_BASELINE.md). The compiler-boundary
self-review result is recorded in
[RIVET_GH_AW_TRUST_PROOF.md](RIVET_GH_AW_TRUST_PROOF.md).

| Document                                            | Type        | Purpose                                                                                           |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| [Installation](../INSTALL.md)                       | How-to      | Evaluate a local package and prove an installation.                                               |
| [Legacy release delivery](RELEASE_READINESS.md)     | Historical  | Superseded Codekeeper release process and its migration status.                                    |
| [Agent change and release safety](AGENT_RELEASE_SAFETY.md) | How-to | Map breaking points and verify every source, package, workflow, and live-release boundary before publication. |
| [Repository governance](REPOSITORY_GOVERNANCE.md)   | How-to      | Review and deliberately apply branch and immutable-tag rules.                                     |
| [Configuration](CONFIGURATION.md)                   | Reference   | Configure policy, workflows, providers, and capabilities.                                         |
| [Architecture](ARCHITECTURE.md)                     | Explanation | Understand the runtime trust pipeline.                                                            |
| [Maintainability](MAINTAINABILITY.md)               | Explanation | Keep compatibility facades, domain modules, and remaining oversized files within reviewed limits. |
| [Authority, data, and cost](authority-data-cost.md) | Explanation | Decide what Codekeeper may change, send, and consume.                                             |
| [Evaluations](EVALUATIONS.md)                       | Reference   | Understand the evaluation method and evidence boundary.                                           |
| [Validation](../VALIDATION.md)                      | How-to      | Validate source and release inputs.                                                               |
| [Support](../SUPPORT.md)                            | Reference   | Get help, report bugs, or report security concerns.                                               |

Start with installation for local evaluation, then review configuration and
authority before enabling any workflow. Use the Rivet migration documentation
for current delivery boundaries; the legacy Codekeeper release process is
retired.
