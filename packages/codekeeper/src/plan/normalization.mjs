import path from "node:path";
import { MODE_IDS } from "../constants.mjs";
import { InstallerError } from "../errors.mjs";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,99})$/;
const CLIENT_ID = /^(?:Iv[A-Za-z0-9]{18,253}|Iv1\.[A-Za-z0-9]{16,253})$/;

export function appSlugFromInput(value) {
  const input = String(value ?? "").trim().toLowerCase();
  const match = input.match(/^(?:https:\/\/github\.com)?\/(?:organizations\/[^/]+\/)?settings\/apps\/([a-z0-9-]+)\/?$/);
  const slug = match?.[1] ?? input;
  return APP_SLUG.test(slug) ? slug : null;
}

export function validDisplayName(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validPrivateKeyPath(value) {
  return typeof value === "string"
    && path.isAbsolute(value)
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validClientId(value) {
  return typeof value === "string"
    && !/[\s\u0000-\u001f\u007f]/.test(value)
    && CLIENT_ID.test(value);
}

export function normalizeModes(modes) {
  if (!Array.isArray(modes))
    throw new InstallerError("Select at least one Codekeeper mode.", {
      code: "PLAN_INVALID"
    });
  const selected = [...new Set(modes)];
  if (!selected.length || selected.some((mode) => !MODE_IDS.includes(mode))) {
    throw new InstallerError("Select at least one supported Codekeeper mode.", {
      code: "PLAN_INVALID"
    });
  }
  return MODE_IDS.filter((mode) => selected.includes(mode));
}

export function normalizeOwnerLogins(ownerLogins) {
  if (!Array.isArray(ownerLogins) || !ownerLogins.length)
    throw new InstallerError("At least one owner login is required.", {
      code: "PLAN_INVALID"
    });
  const normalized = ownerLogins.map((login) => String(login).trim().toLowerCase());
  if (normalized.some((login) => !LOGIN.test(login)) || new Set(normalized).size !== normalized.length) {
    throw new InstallerError("Owner logins must be unique GitHub login names.", { code: "PLAN_INVALID" });
  }
  return normalized;
}
