import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateRivetConfig } from "./config.mjs";

export async function readRivetConfiguration(repositoryRoot) {
  const configPath = path.join(repositoryRoot, ".github/rivet.json");
  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return validateRivetConfig(JSON.parse(content));
  } catch (error) {
    throw new Error(
      `Rivet: invalid configuration at ${configPath}: ${error.message}`,
    );
  }
}
