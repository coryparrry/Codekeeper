export class InstallerError extends Error {
  constructor(message, { code = "INSTALLER_ERROR", resume = null, cause } = {}) {
    super(message, { cause });
    this.name = "InstallerError";
    this.code = code;
    this.resume = resume;
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
  return `Codekeeper setup stopped: ${message}${resume}`;
}
