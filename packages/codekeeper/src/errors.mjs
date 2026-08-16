const RECEIPT_ARRAY_KEYS = Object.freeze([
  "completedSecrets",
  "pendingSecrets",
  "completedVariables",
  "pendingVariables"
]);

const RECEIPT_VALUE_KEYS = Object.freeze([
  "operation",
  "branch",
  "originalHead",
  "localSha",
  "remoteSha",
  "startupState",
  "pullRequestUrl",
  "phase",
  "unknownMutation",
  "settingsOnly",
  "status"
]);

function safeReceiptString(value) {
  return typeof value === "string" ? value : null;
}

/**
 * Receipts are deliberately allow-listed. They are displayed after failures,
 * so accepting arbitrary input here could turn a provider value or child
 * output into a durable diagnostic. The resulting object is deeply frozen
 * and contains only JSON-compatible primitives and arrays of names.
 */
export function freezeInstallerReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const frozen = {};
  for (const key of RECEIPT_VALUE_KEYS) {
    if (!Object.hasOwn(receipt, key)) continue;
    const value = receipt[key];
    if (key === "unknownMutation" || key === "settingsOnly") {
      if (typeof value === "boolean") frozen[key] = value;
    } else if (value === null || typeof value === "string") {
      frozen[key] = safeReceiptString(value);
    }
  }
  for (const key of RECEIPT_ARRAY_KEYS) {
    if (!Object.hasOwn(receipt, key)) continue;
    const value = receipt[key];
    if (!Array.isArray(value)) continue;
    if (value.every((item) => typeof item === "string")) {
      frozen[key] = Object.freeze([...new Set(value)]);
    }
  }
  return Object.freeze(frozen);
}

function formatReceiptProgress(receipt) {
  if (!receipt) return "";
  const completed = [];
  const pending = [];
  if (receipt.remoteSha) completed.push(`✓ Setup branch pushed: ${receipt.branch} @ ${receipt.remoteSha}`);
  for (const name of receipt.completedSecrets ?? []) completed.push(`✓ Secret configured: ${name}`);
  for (const name of receipt.completedVariables ?? []) completed.push(`✓ Variable configured: ${name}`);
  if (receipt.pullRequestUrl) completed.push(`✓ Setup pull request created: ${receipt.pullRequestUrl}`);
  for (const name of receipt.pendingSecrets ?? []) pending.push(`✕ Secret not confirmed: ${name}`);
  for (const name of receipt.pendingVariables ?? []) pending.push(`✕ Variable not confirmed: ${name}`);
  if (receipt.remoteSha && !receipt.pullRequestUrl) pending.push("✕ Setup pull request was not created");
  return ["Installation receipt", "Completed", ...(completed.length ? completed : ["· None"]), "Not completed", ...(pending.length ? pending : ["· None"]), `Phase: ${receipt.phase ?? "unknown"}`, `Startup: ${receipt.startupState ?? "unknown"}`, `Last mutation unconfirmed: ${receipt.unknownMutation ? "yes" : "no"}`, ...(receipt.remoteSha && !receipt.pullRequestUrl ? ["Nothing is running because the setup pull request has not merged."] : [])].join("\n");
}

export class InstallerError extends Error {
  constructor(message, { code = "INSTALLER_ERROR", resume = null, cause, receipt = null } = {}) {
    super(message, { cause });
    this.name = "InstallerError";
    this.code = code;
    this.resume = resume;
    this.receipt = freezeInstallerReceipt(receipt);
  }
}

export function fail(message, options) {
  throw new InstallerError(message, options);
}

export function formatInstallerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const resume = error && typeof error === "object" && typeof error.resume === "string"
    ? `\nResume: ${error.resume}`
    : "";
  const progress = error && typeof error === "object" && error.receipt
    ? `\n${formatReceiptProgress(error.receipt)}`
    : "";
  return `Codekeeper setup stopped: ${message}${progress}${resume}`;
}
