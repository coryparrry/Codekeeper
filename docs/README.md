# Codekeeper documentation

| Document                                            | Type        | Purpose                                                                                           |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| [Installation](../INSTALL.md)                       | How-to      | Evaluate a local package and prove an installation.                                               |
| [Reviewed release delivery](RELEASE_READINESS.md)   | How-to      | Promote reviewed changes through main, Release Please, and the protected npm publisher.           |
| [Repository governance](REPOSITORY_GOVERNANCE.md)   | How-to      | Review and deliberately apply branch and immutable-tag rules.                                     |
| [Configuration](CONFIGURATION.md)                   | Reference   | Configure policy, workflows, providers, and capabilities.                                         |
| [Architecture](ARCHITECTURE.md)                     | Explanation | Understand the runtime trust pipeline.                                                            |
| [Maintainability](MAINTAINABILITY.md)               | Explanation | Keep compatibility facades, domain modules, and remaining oversized files within reviewed limits. |
| [Authority, data, and cost](authority-data-cost.md) | Explanation | Decide what Codekeeper may change, send, and consume.                                             |
| [Evaluations](EVALUATIONS.md)                       | Reference   | Understand the evaluation method and evidence boundary.                                           |
| [Validation](../VALIDATION.md)                      | How-to      | Validate source and release inputs.                                                               |
| [Support](../SUPPORT.md)                            | Reference   | Get help, report bugs, or report security concerns.                                               |

Start with installation for local evaluation, then review configuration and
authority before enabling any workflow. A new version is not published until its
Release Please pull request is explicitly approved and merged.
