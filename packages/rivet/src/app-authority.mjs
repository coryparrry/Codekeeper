import { DEFAULT_RIVET_CONFIG, validateRivetConfig } from "./config.mjs";

export const RIVET_APP_CLIENT_ID_VARIABLE = "RIVET_APP_CLIENT_ID";
export const RIVET_APP_BOT_LOGIN_VARIABLE = "RIVET_APP_BOT_LOGIN";
export const RIVET_APP_PRIVATE_KEY_SECRET = "RIVET_APP_PRIVATE_KEY";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function reviewAppAuthority(configuration = DEFAULT_RIVET_CONFIG) {
  validateRivetConfig(configuration);
  return Object.freeze({
    clientIdVariable: RIVET_APP_CLIENT_ID_VARIABLE,
    privateKeySecret: RIVET_APP_PRIVATE_KEY_SECRET,
    permissions: Object.freeze({
      contents: "read",
      metadata: "read",
      pullRequests: "write",
    }),
    events: Object.freeze([]),
  });
}

export function repairAppAuthority() {
  return Object.freeze({
    clientIdVariable: RIVET_APP_CLIENT_ID_VARIABLE,
    privateKeySecret: RIVET_APP_PRIVATE_KEY_SECRET,
    permissions: Object.freeze({
      contents: "write",
      metadata: "read",
      pullRequests: "write",
    }),
    events: Object.freeze([]),
  });
}

export function reviewAppRegistrationUrl({ repository, ownerType = "User" }) {
  const segments = repository?.split("/") ?? [];
  if (
    !REPOSITORY.test(repository ?? "") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Rivet App registration requires owner/repository");
  }
  if (ownerType !== "User" && ownerType !== "Organization") {
    throw new Error("Rivet App owner must be User or Organization");
  }
  const [owner, name] = repository.split("/");
  const authority = reviewAppAuthority();
  const registrationPath =
    ownerType === "Organization"
      ? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : "/settings/apps/new";
  const parameters = new URLSearchParams({
    name: `Rivet ${name}`.slice(0, 34),
    description: `Rivet review automation for ${repository}`,
    url: `https://github.com/${repository}`,
    public: "false",
    webhook_active: "false",
    contents: authority.permissions.contents,
    pull_requests: authority.permissions.pullRequests,
    metadata: authority.permissions.metadata,
  });
  return `https://github.com${registrationPath}?${parameters.toString()}#rivet-${owner.toLowerCase()}`;
}
