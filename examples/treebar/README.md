# Treebar policy example

This directory is documentation only. Treebar is not a runtime default and this repository does not install anything into Treebar.

To prepare a future Treebar adopter, start from the root `.github/codekeeper.json`, then tailor it in the Treebar repository:

- Set `repository.displayName` to `Treebar`, its actual default branch, and the approved maintainer logins.
- Use an automation prefix such as `automation/treebar/`.
- Add Treebar source and test paths only after confirming them in the target checkout.
- Keep Xcode projects, signing material, entitlements, release metadata, security files, and maintainer tooling protected.
- Keep auto-merge limited to documentation unless Treebar's own checks and ownership rules justify a broader policy.

The generic reusable-workflow installation remains the one described in [INSTALL.md](../../INSTALL.md).
