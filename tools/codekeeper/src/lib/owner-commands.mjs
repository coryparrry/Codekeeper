export const OWNER_COMMANDS = Object.freeze([
  "status",
  "review",
  "rerun",
  "triage",
  "defer",
  "implement",
  "fix",
  "stop"
]);

const COMMAND_PATTERN = OWNER_COMMANDS.join("|");

export function parseDirectOwnerCommand(body) {
  const text = String(body ?? "").trim();
  const direct = text.match(new RegExp(`^/codekeeper\\s+(${COMMAND_PATTERN})$`, "i"));
  return direct ? direct[1].toLowerCase() : null;
}

export function parseMentionOwnerCommand(body, botLogin = "") {
  const text = String(body ?? "").trim();
  const mention = String(botLogin).replace(/\[bot\]$/i, "").trim().toLowerCase();
  if (!mention) return null;
  const escapedMention = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentioned = text.match(new RegExp(`^@${escapedMention}\\s+(${COMMAND_PATTERN})$`, "i"));
  return mentioned ? mentioned[1].toLowerCase() : null;
}

export function parseOwnerCommand(body, botLogin = "") {
  return parseDirectOwnerCommand(body) ?? parseMentionOwnerCommand(body, botLogin);
}
