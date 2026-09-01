import { repairAppAuthority, reviewAppAuthority } from "./app-authority.mjs";
import { productAuthoritySummary } from "./config.mjs";
import { GH_AW_RELEASE } from "./gh-aw/versions.mjs";

function installationReceipt({
  mode,
  config,
  productAuthority,
  githubApp,
  files,
}) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      product: "Rivet",
      mode,
      configSchemaVersion: config.schemaVersion,
      productAuthority,
      githubApp,
      compiler: {
        version: GH_AW_RELEASE.version,
        commit: GH_AW_RELEASE.commit,
        actionsCommit: GH_AW_RELEASE.actionsCommit,
      },
      managedFiles: [...files.keys(), ".github/rivet/installation.json"].sort(),
    },
    null,
    2,
  )}\n`;
}

export function completeInstallationFiles(files, { mode, config }) {
  const productAuthority = productAuthoritySummary(config);
  const githubApp =
    mode === "repair" ? repairAppAuthority(config) : reviewAppAuthority(config);
  files.set(".github/rivet.json", `${JSON.stringify(config, null, 2)}\n`);
  files.set(
    ".github/rivet/installation.json",
    installationReceipt({ mode, config, productAuthority, githubApp, files }),
  );
  return files;
}
