import { parseDocument } from "yaml";

const FULL_SHA = /^[0-9a-f]{40}$/;

function fail(message, options) {
  throw new Error(`Rivet compiled workflow: ${message}`, options);
}

function header(source, name) {
  const prefix = `# ${name}: `;
  const line = source
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) fail(`missing ${name} header`);
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch (cause) {
    fail(`invalid ${name} header`, { cause });
  }
}

function parseWorkflow(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0)
    fail(`invalid YAML: ${document.errors[0].message}`);
  const workflow = document.toJS({ maxAliasCount: 0 });
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    fail("YAML root must be an object");
  }
  return workflow;
}

function actionReference(uses) {
  if (uses.startsWith("./")) return { uses, local: true, pinned: true };
  if (uses.startsWith("docker://"))
    return { uses, container: true, pinned: uses.includes("@sha256:") };
  const separator = uses.lastIndexOf("@");
  const action = separator < 1 ? uses : uses.slice(0, separator);
  const ref = separator < 1 ? "" : uses.slice(separator + 1);
  const [owner, repository] = action.split("/");
  return {
    uses,
    action,
    repository: owner && repository ? `${owner}/${repository}` : action,
    ref,
    local: false,
    pinned: FULL_SHA.test(ref),
  };
}

function permissions(value) {
  if (typeof value === "string") return { "*": value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, permission]) => [key, String(permission)]),
  );
}

function references(source, namespace) {
  return [
    ...source.matchAll(
      new RegExp(`\\b${namespace}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"),
    ),
  ]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

function resolvedImports(source) {
  const lines = source.split("\n");
  const start = lines.indexOf("#   Imports:");
  if (start === -1) return [];
  const imports = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^#     - (.+)$/);
    if (!match) break;
    imports.push(match[1]);
  }
  return imports;
}

export function inspectCompiledWorkflow(source) {
  const workflow = parseWorkflow(source);
  const metadata = header(source, "gh-aw-metadata");
  const manifest = header(source, "gh-aw-manifest");
  const jobs =
    workflow.jobs && typeof workflow.jobs === "object" ? workflow.jobs : {};
  const actions = [];
  const checkouts = [];
  const writeCapableJobs = [];
  const rootPermissions = permissions(workflow.permissions);
  const containers = Array.isArray(manifest.containers)
    ? manifest.containers
    : [];

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    const jobPermissions = permissions(job.permissions ?? workflow.permissions);
    if (
      Object.values(jobPermissions).some(
        (value) => value === "write" || value === "write-all",
      )
    ) {
      writeCapableJobs.push({ job: jobId, permissions: jobPermissions });
    }
    const usesValues = [];
    if (typeof job.uses === "string")
      usesValues.push({ uses: job.uses, with: job.with ?? {} });
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (step && typeof step.uses === "string") usesValues.push(step);
    }
    for (const step of usesValues) {
      const action = actionReference(step.uses);
      actions.push({ job: jobId, ...action });
      if (action.action === "actions/checkout") {
        checkouts.push({
          job: jobId,
          repository: step.with?.repository ?? null,
          ref: step.with?.ref ?? null,
          path: step.with?.path ?? null,
          persistCredentials: step.with?.["persist-credentials"] ?? true,
        });
      }
    }
  }

  return Object.freeze({
    metadata,
    manifest,
    inlinedImports: /^# inlined-imports: true$/m.test(source),
    resolvedImports: resolvedImports(source),
    triggers: Object.keys(workflow.on ?? {}).sort(),
    permissions: rootPermissions,
    secrets: references(source, "secrets"),
    variables: references(source, "vars"),
    actions,
    localActions: [
      ...new Set(
        actions.filter((action) => action.local).map((action) => action.uses),
      ),
    ].sort(),
    actionRepositories: [
      ...new Set(actions.map((action) => action.repository).filter(Boolean)),
    ].sort(),
    unpinnedActions: actions.filter((action) => !action.pinned),
    containers,
    unpinnedContainers: containers.filter(
      ({ image, digest, pinned_image: pinnedImage }) =>
        typeof image !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(digest) ||
        pinnedImage !== `${image}@${digest}`,
    ),
    checkouts,
    additionalRepositories: [
      ...new Set(
        checkouts.map((checkout) => checkout.repository).filter(Boolean),
      ),
    ].sort(),
    writeCapableJobs,
    safeOutputJobs: Object.keys(jobs).filter(
      (job) => job === "safe_outputs" || job.startsWith("safe_output_"),
    ),
    runtimeImports: [
      ...source.matchAll(/\{\{#runtime-import\s+([^}]+)\}\}/g),
    ].map((match) => match[1].trim()),
  });
}
