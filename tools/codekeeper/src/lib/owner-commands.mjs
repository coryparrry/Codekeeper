const COMMAND_SURFACES = Object.freeze([
  "issue",
  "pull-request",
  "review-thread",
]);

const commandDefinition = (definition) => {
  const surfaces = Object.freeze([...definition.surfaces]);
  const aliases = Object.freeze(
    (definition.aliases ?? []).map((alias) =>
      Object.freeze({
        command: typeof alias === "string" ? alias : alias.command,
        surfaces: Object.freeze([
          ...(typeof alias === "string" ? surfaces : alias.surfaces),
        ]),
      }),
    ),
  );
  return Object.freeze({ ...definition, aliases, surfaces });
};

/**
 * The only user-facing command vocabulary. Compatibility aliases stay attached
 * to the canonical command so parsing, authorization, and help cannot drift.
 */
export const OWNER_COMMAND_DEFINITIONS = Object.freeze([
  commandDefinition({
    command: "help",
    aliases: [],
    surfaces: COMMAND_SURFACES,
    description: "Show commands available on this issue or pull request.",
  }),
  commandDefinition({
    command: "status",
    aliases: [],
    surfaces: COMMAND_SURFACES,
    description: "Show the current Codekeeper state and labels.",
  }),
  commandDefinition({
    command: "review",
    aliases: [
      { command: "rerun", surfaces: ["pull-request", "review-thread"] },
      { command: "triage", surfaces: COMMAND_SURFACES },
    ],
    surfaces: COMMAND_SURFACES,
    description: "Queue issue triage or a pull-request review.",
  }),
  commandDefinition({
    command: "implement",
    aliases: [],
    surfaces: ["issue"],
    description: "Queue bounded implementation for an eligible issue.",
  }),
  commandDefinition({
    command: "repair",
    aliases: ["fix"],
    surfaces: ["pull-request", "review-thread"],
    description: "Queue a bounded repair for a pull request.",
  }),
  commandDefinition({
    command: "defer",
    aliases: [],
    surfaces: ["review-thread"],
    description: "Defer review feedback to issue triage.",
  }),
  commandDefinition({
    command: "pause",
    aliases: ["stop"],
    surfaces: COMMAND_SURFACES,
    description: "Pause automatic implementation, repair, and merge.",
  }),
]);

const definitionsByCommand = new Map();
for (const definition of OWNER_COMMAND_DEFINITIONS) {
  definitionsByCommand.set(definition.command, definition);
  for (const alias of definition.aliases)
    definitionsByCommand.set(alias.command, definition);
}

export const OWNER_COMMANDS = Object.freeze([...definitionsByCommand.keys()]);

const COMMAND_PATTERN = OWNER_COMMANDS.map((command) =>
  command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");

function definitionFor(command) {
  return (
    definitionsByCommand.get(
      String(command ?? "")
        .trim()
        .toLowerCase(),
    ) ?? null
  );
}

/** Normalize a parsed command before any authorization decision is made. */
export function normalizeOwnerCommand(command) {
  return definitionFor(command)?.command ?? null;
}

export function ownerCommandDefinition(command) {
  return definitionFor(command);
}

export function ownerCommandAvailableOnSurface(command, surface) {
  const normalized = String(command ?? "").trim().toLowerCase();
  const definition = definitionFor(normalized);
  if (!definition) return false;
  const normalizedSurface = COMMAND_SURFACES.includes(surface) ? surface : "issue";
  if (definition.command === normalized) {
    return definition.surfaces.includes(normalizedSurface);
  }
  return definition.aliases.some(
    (alias) => alias.command === normalized && alias.surfaces.includes(normalizedSurface),
  );
}

export function ownerCommandSurface(event) {
  if (
    event?.comment?.pull_request_review_id !== undefined ||
    event?.comment?.in_reply_to_id !== undefined ||
    event?.comment?.path
  ) {
    return "review-thread";
  }
  if (event?.pull_request || event?.issue?.pull_request) return "pull-request";
  return "issue";
}

function surfaceLabel(surface) {
  if (surface === "pull-request") return "pull request";
  if (surface === "review-thread") return "review thread";
  return "issue";
}

function displayCommand(command) {
  return `/codekeeper ${String(command ?? "")
    .trim()
    .toLowerCase()}`;
}

function canonicalDisplayCommand(command) {
  return `/codekeeper ${normalizeOwnerCommand(command) ?? command}`;
}

export function commandsForSurface(surface, { repairAvailable = true } = {}) {
  const normalizedSurface = COMMAND_SURFACES.includes(surface)
    ? surface
    : "issue";
  return OWNER_COMMAND_DEFINITIONS.filter(
    (definition) =>
      definition.surfaces.includes(normalizedSurface) &&
      (repairAvailable || definition.command !== "repair"),
  );
}

function compatibilityText(definitions = OWNER_COMMAND_DEFINITIONS, surface = null) {
  const aliases = definitions.flatMap((definition) =>
    definition.aliases
      .filter((alias) => surface === null || alias.surfaces.includes(surface))
      .map(
      (alias) =>
        `\`${displayCommand(alias.command)}\` → \`${canonicalDisplayCommand(definition.command)}\``,
      ),
  );
  return aliases.length ? `Compatibility aliases: ${aliases.join(", ")}.` : "";
}

export function renderOwnerCommandHelp(surface = "issue", options = {}) {
  const normalizedSurface = COMMAND_SURFACES.includes(surface)
    ? surface
    : "issue";
  const commands = commandsForSurface(normalizedSurface, options);
  const rows = commands.map(
    (definition) =>
      `- \`/codekeeper ${definition.command}\` — ${definition.description}`,
  );
  return [
    "## Codekeeper help",
    "",
    `Commands available on this ${surfaceLabel(normalizedSurface)}:`,
    "",
    ...rows,
    "",
    compatibilityText(commands, normalizedSurface),
    "Free-form requests are ignored; commands must be an exact command or an exact bot mention.",
  ].join("\n");
}

function labels(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );
}

export function renderOwnerCommandStatus({
  issue,
  command,
  outcome,
  config,
  surface = "issue",
  repairAvailable = true,
}) {
  const active = labels(issue).filter(
    (label) => config?.labels && Object.hasOwn(config.labels, label),
  );
  const canonical = normalizeOwnerCommand(command) ?? command;
  const commands = commandsForSurface(surface, { repairAvailable });
  const available = commands
    .map((definition) => `\`/codekeeper ${definition.command}\``)
    .join(", ");
  return [
    "## Codekeeper status",
    "",
    "| Item | State |",
    "|---|---|",
    `| Surface | ${surfaceLabel(surface)} |`,
    `| Command | \`/codekeeper ${canonical}\` |`,
    `| Result | ${outcome} |`,
    `| Codekeeper labels | ${active.length ? active.map((label) => `\`${label}\``).join(", ") : "None"} |`,
    "",
    `Available commands: ${available}.`,
    "",
    compatibilityText(commands, surface),
  ].join("\n");
}

export function parseDirectOwnerCommand(body) {
  const text = String(body ?? "").trim();
  const direct = text.match(
    new RegExp(`^/codekeeper\\s+(${COMMAND_PATTERN})$`, "i"),
  );
  return direct ? direct[1].toLowerCase() : null;
}

export function parseMentionOwnerCommand(body, botLogin = "") {
  const text = String(body ?? "").trim();
  const mention = String(botLogin)
    .replace(/\[bot\]$/i, "")
    .trim()
    .toLowerCase();
  if (!mention) return null;
  const escapedMention = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentioned = text.match(
    new RegExp(`^@${escapedMention}\\s+(${COMMAND_PATTERN})$`, "i"),
  );
  return mentioned ? mentioned[1].toLowerCase() : null;
}

export function parseAnyMentionOwnerCommand(body) {
  const text = String(body ?? "").trim();
  const mentioned = text.match(new RegExp(`^@\\S+\\s+(${COMMAND_PATTERN})$`, "i"));
  return mentioned ? mentioned[1].toLowerCase() : null;
}

export function parseOwnerCommand(body, botLogin = "") {
  return (
    parseDirectOwnerCommand(body) ?? parseMentionOwnerCommand(body, botLogin)
  );
}
