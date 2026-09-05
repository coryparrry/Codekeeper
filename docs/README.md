# Rivet documentation

Rivet is the active package and workflow system. Its architecture, configuration,
and delivery gates are documented here. The completed gh-aw migration decisions
remain in [RIVET_GH_AW_MIGRATION.md](RIVET_GH_AW_MIGRATION.md), with the legacy
comparison checkpoint in [RIVET_LEGACY_BASELINE.md](RIVET_LEGACY_BASELINE.md).
The compiler-boundary self-review result is recorded in
[RIVET_GH_AW_TRUST_PROOF.md](RIVET_GH_AW_TRUST_PROOF.md).

| Document                                                   | Type        | Purpose                                                                                                       |
| ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| [Installation](../INSTALL.md)                              | How-to      | Evaluate a local package and prove an installation.                                                           |
| [Legacy release delivery](RELEASE_READINESS.md)            | Historical  | Superseded Codekeeper release process and its migration status.                                               |
| [Agent change and release safety](AGENT_RELEASE_SAFETY.md) | How-to      | Map breaking points and verify every source, package, workflow, and live-release boundary before publication. |
| [Repository governance](REPOSITORY_GOVERNANCE.md)          | How-to      | Review and deliberately apply branch and immutable-tag rules.                                                 |
| [Configuration](CONFIGURATION.md)                          | Reference   | Configure policy, workflows, providers, and capabilities.                                                     |
| [Architecture](ARCHITECTURE.md)                            | Explanation | Understand the runtime trust pipeline.                                                                        |
| [Maintainability](MAINTAINABILITY.md)                      | Explanation | Keep compatibility facades, domain modules, and remaining oversized files within reviewed limits.             |
| [Authority, data, and cost](authority-data-cost.md)        | Explanation | Decide what Rivet may change, send, and consume.                                                              |
| [Evaluations](EVALUATIONS.md)                              | Reference   | Understand the evaluation method and evidence boundary.                                                       |
| [Validation](../VALIDATION.md)                             | How-to      | Validate source and release inputs.                                                                           |
| [Support](../SUPPORT.md)                                   | Reference   | Get help, report bugs, or report security concerns.                                                           |

Start with installation for local evaluation, then review configuration,
architecture, and authority before enabling any workflow. The legacy
Codekeeper release process is retired.
