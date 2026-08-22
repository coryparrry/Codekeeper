import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AGENT_PROFILE_BUNDLE_FILE, loadTrustedAgentProfile } from "./agent-profiles.mjs";
import { providerCompatibleJsonSchema } from "./schemas.mjs";
import { assertRunnerOwnedDirectory } from "./workspace.mjs";
import { writeJson, writeText } from "./io.mjs";

export function boundedText(value, maximum, suffix = "\n…[truncated]") {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

export function boundedLabels(labels, maximum = 30) {
  return (labels ?? []).slice(0, maximum).map((label) => boundedText(typeof label === "string" ? label : label?.name, 128, "…"));
}

export function configuredOwnerLogins(config) {
  return new Set((config.repository.ownerLogins ?? []).map((login) => String(login).trim().toLowerCase()));
}

export function isConfiguredOwner(config, actor) {
  const normalizedActor = String(actor ?? "")
    .trim()
    .toLowerCase();
  return normalizedActor.length > 0 && configuredOwnerLogins(config).has(normalizedActor);
}

export async function writeBundle({ directory, context, prompt, workspacePrompt, schema, agentProfile }) {
  directory = assertRunnerOwnedDirectory(directory);
  await mkdir(path.dirname(directory), { recursive: true });
  directory = assertRunnerOwnedDirectory(directory);
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Runner-owned bundle directory already exists: ${directory}`);
    throw error;
  }
  directory = assertRunnerOwnedDirectory(directory);
  await writeFile(path.join(directory, AGENT_PROFILE_BUNDLE_FILE), agentProfile.bytes, { flag: "wx" });
  await writeJson(path.join(directory, "context.json"), context);
  await writeText(path.join(directory, "prompt.md"), `${prompt}\n`);
  await writeText(path.join(directory, "workspace-prompt.md"), `${workspacePrompt}\n`);
  await writeJson(path.join(directory, "schema.json"), providerCompatibleJsonSchema(schema));
}

export function trustedAgentProfile(mode, agentProfilePath, agentProfileSourceSha, agentProfileSource) {
  return loadTrustedAgentProfile({ mode, source: agentProfileSource, sourcePath: agentProfilePath, sourceSha: agentProfileSourceSha });
}

export function runMetadata({ toolingSha = process.env.CODEKEEPER_TOOLING_SHA ?? "", configSha256 = "" } = {}) {
  return { runId: process.env.GITHUB_RUN_ID ?? "", toolingSha: String(toolingSha).trim(), configSha256: String(configSha256).trim() };
}

export function boundedOwnerComments(comments, config) {
  const owners = configuredOwnerLogins(config);
  return comments
    .filter((comment) =>
      owners.has(
        String(comment.user?.login ?? "")
          .trim()
          .toLowerCase(),
      ),
    )
    .slice(-5)
    .map((comment) => ({
      author: boundedText(comment.user?.login, 256, "…"),
      body: boundedText(comment.body, 2000),
      createdAt: comment.created_at ?? "",
    }));
}
