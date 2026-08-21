# Codekeeper

Codekeeper is a guided CLI that installs an always-available maintainer in a
GitHub.com repository. It reviews pull requests, triages issues, audits
repository health, and can prepare small, verified repairs from GitHub Actions
you own.

You do not write the workflows by hand. The CLI helps you choose models,
capabilities, validation commands, and GitHub App permissions, then opens a
setup pull request for you to review. It never merges that pull request.

Requires **Node.js 22 or newer**, Git, an authenticated
[GitHub CLI](https://cli.github.com/), and permission to administer the target
repository.

## Install

From a clean checkout of the repository's default branch:

```bash
npx @coryparry/codekeeper@0.2.0 init
```

The installer:

1. checks Node, Git, GitHub CLI authentication, admin access, and checkout state;
2. lets you choose **Recommended** (automatic PR review and manual maintenance)
   or **Customize**;
3. helps you create an adopter-owned GitHub App with the required permissions;
4. uploads provider credentials and the App private key to GitHub secrets; and
5. opens a setup pull request. It does not merge it.

After you merge that pull request, from a clean checkout of the default branch:

```bash
npx @coryparry/codekeeper@0.2.0 verify
```

Open one small same-repository pull request and confirm the App-authored
review before you make the review gate required.

## What the installer writes

Selected workflows determine the exact set. A Recommended install typically
includes:

- `.github/codekeeper.json` — policy, models, and safety boundaries
- `.github/codekeeper-release.json` — installed package identity and receipt
- `.github/codekeeper/README.md` — ownership of installed files
- `.github/codekeeper/actions/acquire-package/action.yml` — exact package fetch
- `.github/workflows/codekeeper-assistant.yml` and matching `codekeeper-runtime-*.yml`
- caller workflows such as `.github/workflows/codekeeper-review.yml`

Optional `.github/codekeeper/agents/*.md` files override packaged agent
profiles after they merge to the default branch.

## GitHub App and secrets

The installer creates or updates repository secrets and variables. It does not
print their values.

Typical names:

| Name | Kind | Purpose |
|---|---|---|
| `CODEKEEPER_ENABLED` | variable | Startup switch; set last |
| `CODEKEEPER_APP_CLIENT_ID` | variable | GitHub App client ID |
| `CODEKEEPER_AUTOMATION_BOT_LOGIN` | variable | Trusted App bot login |
| `CODEKEEPER_APP_PRIVATE_KEY` | secret | App PEM |
| `OPENAI_API_KEY` | secret | OpenAI model calls when selected |
| `DEEPSEEK_API_KEY` | secret | DeepSeek when selected |
| `OPENROUTER_API_KEY` | secret | OpenRouter when selected |
| `OPENAI_TRACE_API_KEY` | secret | Optional tracing; do not reuse the model key |

Install the App only on the selected repository. Do not paste the PEM into the
terminal; choose the downloaded file in the installer.

## CLI

```text
npx @coryparry/codekeeper@0.2.0 init
npx @coryparry/codekeeper@0.2.0 update
npx @coryparry/codekeeper@0.2.0 update --to X.Y.Z
npx @coryparry/codekeeper@0.2.0 update --check
npx @coryparry/codekeeper@0.2.0 rollback --to X.Y.Z
npx @coryparry/codekeeper@0.2.0 doctor [--json]
npx @coryparry/codekeeper@0.2.0 verify [--json] [--controlled]
```

`init` also reopens guided settings for an existing installation. `update`
moves to a newer verified release. `rollback --to` asks that older release to
open a normal update pull request; it never force-pushes.

To pack this source checkout into a local tarball instead of using npm, see
[INSTALL.md](https://github.com/coryparrry/Codekeeper/blob/main/INSTALL.md).

## Supported surface

- GitHub.com repositories. GitHub Enterprise Server is not supported.
- Review: same-repository, non-draft pull requests.
- Automatic repair and automatic merge stay limited to the configured default
  branch.
- Forks, drafts, and merge queues are outside the supported surface.
- Installed runtimes use ephemeral GitHub-hosted Ubuntu runners. Persistent
  shared self-hosted runners are unsupported.
- Code-changing capabilities need a deterministic repository validation command
  beyond `git diff --check`.

Recommended starts with repair, issue implementation, duplicate closure,
scheduled maintenance, tracing, and automatic merge **off**.

## Documentation

- [Source repository](https://github.com/coryparrry/Codekeeper)
- [Configuration](https://github.com/coryparrry/Codekeeper/blob/main/docs/CONFIGURATION.md)
- [Authority, data, and cost](https://github.com/coryparrry/Codekeeper/blob/main/docs/authority-data-cost.md)
- [Architecture](https://github.com/coryparrry/Codekeeper/blob/main/docs/ARCHITECTURE.md)
- [Support](https://github.com/coryparrry/Codekeeper/blob/main/SUPPORT.md)

Bundled source checkpoint: `e33e4ad6475940a8dc095e9dc2dae14a921ac05b`.

## Security

Do not commit provider keys, GitHub App private keys, tokens, or live traces.
Report vulnerabilities through GitHub private vulnerability reporting as
described in
[SECURITY.md](https://github.com/coryparrry/Codekeeper/blob/main/SECURITY.md).

## License

Apache-2.0. See [LICENSE](https://github.com/coryparrry/Codekeeper/blob/main/LICENSE).
