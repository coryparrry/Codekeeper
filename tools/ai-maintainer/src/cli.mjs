#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./lib/config.mjs";
import { log, parseArgs, setGitHubOutput } from "./lib/io.mjs";
import { prepareAudit, prepareFix, prepareIssue, prepareReview } from "./lib/prepare.mjs";
import { publishAudit, publishFix, publishIssue, publishReview } from "./lib/publish.mjs";
import { sealAudit, sealFix, sealIssue, sealReview, validateAudit, validateFix, validateIssue, validateReview, verifyAudit, verifyFix } from "./lib/validate.mjs";
import { assertRunnerOwnedDirectory } from "./lib/workspace.mjs";
import { sha256 } from "./lib/markers.mjs";

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function bundleFile(directory, filePath, flag) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(directory, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === "..") {
    throw new Error(`--${flag} must be a file inside the runner-owned --directory`);
  }
  return resolved;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  if (!command) throw new Error("A command is required");
  const sealedPublishCommands = new Set(["publish-review", "publish-audit", "publish-issue", "publish-fix"]);
  const artifactDirectory = args.get("artifact")
    ? assertRunnerOwnedDirectory(args.get("artifact"))
    : null;
  const configPath = args.get(
    "config",
    sealedPublishCommands.has(command)
      ? path.join(artifactDirectory ?? assertRunnerOwnedDirectory(args.require("artifact")), "config.json")
      : ".github/ai-maintainer.json"
  );
  const { config, path: loadedConfigPath } = await loadConfig(configPath);
  const configSha256 = sha256(await readFile(loadedConfigPath));
  const usesRunnerDirectory = command.startsWith("prepare-") || command.startsWith("validate-");
  const directory = usesRunnerDirectory
    ? assertRunnerOwnedDirectory(args.require("directory"))
    : null;
  const token = args.get("token", process.env.GITHUB_TOKEN);
  const contextPath = directory
    ? bundleFile(directory, args.get("context", path.join(directory, "context.json")), "context")
    : null;
  const dryRun = args.boolean("dry-run", false);
  const toolingSha = args.get("tooling-sha", process.env.AI_MAINTAINER_TOOLING_SHA ?? "");

  let result;
  switch (command) {
    case "check-config":
      result = { valid: true, version: config.version };
      break;
    case "prepare-review":
      result = await prepareReview({ eventPath: args.require("event"), directory, config, toolingSha, configSha256 });
      break;
    case "prepare-audit":
      result = await prepareAudit({ directory, config, toolingSha, configSha256 });
      break;
    case "prepare-issue":
      result = await prepareIssue({ eventPath: args.require("event"), actor: args.require("actor"), directory, config, token, toolingSha, configSha256 });
      break;
    case "prepare-fix":
      result = await prepareFix({
        issueNumber: integer(args.require("issue-number"), "issue-number"),
        actor: args.require("actor"),
        directory,
        config,
        token,
        toolingSha,
        configSha256
      });
      break;
    case "validate-review":
      result = await validateReview({ directory, contextPath, resultPath: bundleFile(directory, args.require("result"), "result"), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), config, configSha256 });
      break;
    case "validate-audit":
      result = await validateAudit({ directory, contextPath, resultPath: bundleFile(directory, args.require("result"), "result"), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), config, configSha256 });
      break;
    case "validate-issue":
      result = await validateIssue({ directory, contextPath, resultPath: bundleFile(directory, args.require("result"), "result"), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), config, configSha256 });
      break;
    case "validate-fix":
      result = await validateFix({
        directory,
        contextPath,
        resultPath: bundleFile(directory, args.require("result"), "result"),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        config,
        configSha256,
        issueNumber: integer(args.require("issue-number"), "issue-number")
      });
      break;
    case "seal-review":
      result = await sealReview({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "seal-audit":
      result = await sealAudit({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "seal-issue":
      result = await sealIssue({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "seal-fix":
      result = await sealFix({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "verify-audit":
      result = await verifyAudit({
        candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        config,
        configSha256
      });
      break;
    case "verify-fix":
      result = await verifyFix({
        candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        config,
        configSha256
      });
      break;
    case "publish-review":
      result = await publishReview({ artifactDirectory, config, configSha256, token, dryRun });
      break;
    case "publish-audit":
      result = await publishAudit({ artifactDirectory, config, configSha256, token, dryRun });
      break;
    case "publish-issue":
      result = await publishIssue({ artifactDirectory, config, configSha256, token, dryRun });
      break;
    case "publish-fix":
      result = await publishFix({ artifactDirectory, config, configSha256, token, dryRun });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  await setGitHubOutput("result", JSON.stringify(result));
  if (result?.candidateSha256) await setGitHubOutput("candidate_sha256", result.candidateSha256);
  log(`${command} completed`);

  if (command === "publish-review" && result.blocking) {
    throw new Error("AI maintainer review found blocking findings for the current pull request head");
  }
}

main().catch((error) => {
  console.error(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
});
