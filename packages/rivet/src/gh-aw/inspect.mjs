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

function jobCondition(value) {
  return value === undefined ? null : value;
}

function jobNeeds(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return [...value];
  return value;
}

function stepById(jobs, jobId, stepId) {
  const steps = jobs[jobId]?.steps;
  if (!Array.isArray(steps)) return null;
  return (
    steps.find(
      (step) => step && typeof step === "object" && step.id === stepId,
    ) ?? null
  );
}

function parseJsonValue(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeOutputDetails(jobs) {
  const processStep = stepById(jobs, "safe_outputs", "process_safe_outputs");
  const processEnvironment = processStep?.env ?? {};
  const noopStep = stepById(jobs, "conclusion", "noop");
  const incompleteStep = stepById(jobs, "conclusion", "report_incomplete");
  const failureStep = stepById(jobs, "conclusion", "handle_agent_failure");
  return {
    config: parseJsonValue(
      processEnvironment.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG,
    ),
    settings: {
      failureReportAsIssue:
        failureStep?.env?.GH_AW_FAILURE_REPORT_AS_ISSUE ?? null,
      missingDataReportAsFailure:
        failureStep?.env?.GH_AW_MISSING_DATA_REPORT_AS_FAILURE ?? null,
      missingToolReportAsFailure:
        failureStep?.env?.GH_AW_MISSING_TOOL_REPORT_AS_FAILURE ?? null,
      noopReportAsIssue: noopStep?.env?.GH_AW_NOOP_REPORT_AS_ISSUE ?? null,
      reportIncompleteCreateIssue:
        incompleteStep?.env?.GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE ?? null,
    },
  };
}

function jobAuthority(job, workflowPermissions) {
  return {
    concurrency: job.concurrency ?? null,
    container: job.container ?? null,
    continueOnError: job["continue-on-error"] ?? null,
    defaults: job.defaults ?? null,
    env: job.env ?? {},
    environment: job.environment ?? null,
    outputs: job.outputs ?? {},
    permissions: permissions(job.permissions ?? workflowPermissions),
    runsOn: job["runs-on"] ?? null,
    secrets: job.secrets ?? null,
    services: job.services ?? null,
    strategy: job.strategy ?? null,
    timeoutMinutes: job["timeout-minutes"] ?? null,
  };
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
  const scripts = [];
  const jobConditions = {};
  const jobAuthorityById = {};
  const checkouts = [];
  const writeCapableJobs = [];
  const rootPermissions = permissions(workflow.permissions);
  const containers = Array.isArray(manifest.containers)
    ? manifest.containers
    : [];
  const safeOutputDetailsValue = safeOutputDetails(jobs);

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    jobConditions[jobId] = {
      if: jobCondition(job.if),
      needs: jobNeeds(job.needs),
    };
    jobAuthorityById[jobId] = jobAuthority(job, workflow.permissions);
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
      usesValues.push({
        uses: job.uses,
        with: job.with ?? {},
        env: job.env ?? {},
        if: jobCondition(job.if),
        "continue-on-error": job["continue-on-error"] ?? null,
        "timeout-minutes": job["timeout-minutes"] ?? null,
      });
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (step && typeof step.run === "string") {
        scripts.push({
          job: jobId,
          id: step.id ?? null,
          name: step.name ?? null,
          if: jobCondition(step.if),
          run: step.run,
          shell: step.shell ?? null,
          env: step.env ?? {},
          workingDirectory: step["working-directory"] ?? null,
          continueOnError: step["continue-on-error"] ?? null,
          timeoutMinutes: step["timeout-minutes"] ?? null,
        });
      }
      if (step && typeof step.uses === "string") usesValues.push(step);
    }
    for (const step of usesValues) {
      const action = actionReference(step.uses);
      actions.push({
        job: jobId,
        id: step.id ?? null,
        name: step.name ?? null,
        ...action,
        with: step.with ?? {},
        env: step.env ?? {},
        if: jobCondition(step.if),
        continueOnError: step["continue-on-error"] ?? null,
        timeoutMinutes: step["timeout-minutes"] ?? null,
      });
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

  const gatewayScript = scripts.find(
    ({ job, name }) => job === "agent" && name === "Start MCP Gateway",
  )?.run;
  const codexScript = scripts.find(
    ({ job, name }) => job === "agent" && name === "Execute Codex CLI",
  )?.run;

  return Object.freeze({
    metadata,
    manifest,
    inlinedImports: /^# inlined-imports: true$/m.test(source),
    resolvedImports: resolvedImports(source),
    triggers: Object.keys(workflow.on ?? {}).sort(),
    triggerConfig: workflow.on ?? {},
    permissions: rootPermissions,
    concurrency: workflow.concurrency ?? null,
    workflowDefaults: workflow.defaults ?? null,
    workflowEnv: workflow.env ?? {},
    secrets: references(source, "secrets"),
    manifestSecrets: Array.isArray(manifest.secrets)
      ? [...manifest.secrets].sort()
      : [],
    variables: references(source, "vars"),
    jobConditions,
    jobAuthority: jobAuthorityById,
    actions,
    scripts,
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
    safeOutputConfig: safeOutputDetailsValue.config,
    safeOutputSettings: safeOutputDetailsValue.settings,
    safeOutputJobs: Object.keys(jobs).filter(
      (job) => job === "safe_outputs" || job.startsWith("safe_output_"),
    ),
    runtimeImports: [
      ...source.matchAll(/\{\{#runtime-import\s+([^}]+)\}\}/g),
    ].map((match) => match[1].trim()),
    githubMcpEnabled:
      containers.some(({ image }) =>
        String(image).startsWith("ghcr.io/github/github-mcp-server"),
      ) || /\[mcp_servers\.github\]/.test(gatewayScript ?? ""),
    shellToolDisabled:
      /codex_harness\.cjs codex exec[^\n]* -c features\.shell_tool=false(?:\s|$)/.test(
        codexScript ?? "",
      ),
  });
}
