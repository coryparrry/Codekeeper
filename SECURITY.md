# Security policy

Do not report vulnerabilities in public issues. Use this repository's private vulnerability reporting channel on GitHub. If it is unavailable, contact the maintainers privately through the repository owner.

Please include the affected workflow or CLI command, a minimal reproduction, impact, and any proposed mitigation. Do not include credentials, private keys, or live tokens.

Security reports are assessed for the reusable workflows, CLI, policy examples, and release artifacts. Adopter GitHub Apps, secrets, branch rules, and repository policies remain the adopter's responsibility.

The starter policy exports Agents SDK traces with `includeSensitiveData=false`. Configure its required `trace_api_key` as a dedicated OpenAI credential, separate from model-provider and workspace keys. Treat access to [OpenAI Platform Traces](https://platform.openai.com/traces) / **Logs > Traces** as sensitive operational access; do not enable sensitive trace data without an explicit adopter review.
