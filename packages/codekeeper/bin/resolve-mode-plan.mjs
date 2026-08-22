#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveModePlan } from "../src/mode-plan.mjs";

function usage() {
  return [
    "Usage: resolve-mode-plan [options]",
    "",
    "  --mode <mode|auto>                         Requested package mode",
    "  --event <event-name>                        Trusted event name",
    "  --command <command>                        Validated owner command",
    "  --surface <issue|pull-request|review-thread> Trusted owner-command surface",
    "  --target-number <number>                   Issue or pull request number",
    "  --dry-run                                  Disable live publication",
    "  --dry-run-value <boolean>                  Set dry-run from a trusted workflow input",
    "  --event-payload <path>                     Read action and target from the trusted event payload",
    "  --policy-config <path>                     Read permission policy from frozen Codekeeper config",
    "  --candidate-requires-validation <boolean>  Set validated candidate context",
    "  --publication-enabled <boolean>            Set validated publication context",
    "  --ready-label-fix <boolean>                 Authorize the verified ready-label route",
    "  --input <path>                             Read a JSON resolver context",
    "  --json <json>                              Read a JSON resolver context",
  ].join("\n");
}

function parseBoolean(value, name) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new TypeError(`${name} must be true or false.`);
}

function takeValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new TypeError(`${name} requires a value.`);
  return value;
}

export function parseResolverArgs(args) {
  const context = { requestedMode: "auto", event: {}, policy: {} };
  let inputSource = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--mode") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.requestedMode = takeValue(args, index, "--mode");
      index += 1;
    } else if (argument === "--event") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.event.eventName = takeValue(args, index, "--event");
      index += 1;
    } else if (argument === "--command") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.event.command = takeValue(args, index, "--command");
      index += 1;
    } else if (argument === "--surface") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.event.surface = takeValue(args, index, "--surface");
      index += 1;
    } else if (argument === "--target-number") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.event.targetNumber = takeValue(args, index, "--target-number");
      index += 1;
    } else if (argument === "--dry-run") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.event.dryRun = true;
    } else if (argument === "--dry-run-value") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.event.dryRun = parseBoolean(
        takeValue(args, index, "--dry-run-value"),
        argument,
      );
      index += 1;
    } else if (argument === "--event-payload") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.eventPayloadPath = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--policy-config") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.policyConfigPath = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--candidate-requires-validation") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.policy.candidateRequiresValidation = parseBoolean(
        takeValue(args, index, "--candidate-requires-validation"),
        argument,
      );
      index += 1;
    } else if (argument === "--publication-enabled") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.policy.publicationEnabled = parseBoolean(
        takeValue(args, index, "--publication-enabled"),
        argument,
      );
      index += 1;
    } else if (argument === "--ready-label-fix") {
      if (inputSource)
        throw new TypeError(
          "JSON input options cannot be combined with field options.",
        );
      context.policy.readyLabelFix = parseBoolean(
        takeValue(args, index, "--ready-label-fix"),
        argument,
      );
      index += 1;
    } else if (argument === "--input" || argument === "--json") {
      if (inputSource || index > 0)
        throw new TypeError(
          "The resolver accepts exactly one JSON input option.",
        );
      const value = takeValue(args, index, argument);
      context.input =
        argument === "--input" ? { path: value } : { json: value };
      inputSource = true;
      index += 1;
    } else {
      throw new TypeError(`Unknown option: ${argument}`);
    }
  }
  return context;
}

async function loadContext(parsed) {
  if (parsed.input) {
    const source = parsed.input.path
      ? parsed.input.path === "-"
        ? readFileSync(0, "utf8")
        : await readFile(parsed.input.path, "utf8")
      : parsed.input.json;
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Resolver input must be a JSON object.");
    }
    const allowed = new Set(["requestedMode", "event", "policy"]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length)
      throw new TypeError(
        `Resolver input contains unknown properties: ${unknown.join(", ")}`,
      );
    return value;
  }
  const { eventPayloadPath, policyConfigPath, ...context } = parsed;
  if (eventPayloadPath) {
    const payload = JSON.parse(await readFile(eventPayloadPath, "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("Trusted event payload must be a JSON object.");
    }
    context.event.action = payload.action;
    const payloadTargetNumber =
      payload.pull_request?.number ??
      payload.issue?.number ??
      payload.client_payload?.number;
    if (
      context.event.targetNumber === undefined &&
      payloadTargetNumber !== undefined
    ) {
      context.event.targetNumber = payloadTargetNumber;
    }
  }
  if (policyConfigPath) {
    const config = JSON.parse(await readFile(policyConfigPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("Codekeeper policy config must be a JSON object.");
    }
    context.policy.review = {
      autoRepair: config.review?.autoRepair === true,
    };
    context.policy.audit = {
      repair: { enabled: config.audit?.repair?.enabled === true },
    };
  }
  return context;
}

export async function main(
  args = process.argv.slice(2),
  output = process.stdout,
  errorOutput = process.stderr,
) {
  try {
    const parsed = parseResolverArgs(args);
    if (parsed.help) {
      output.write(`${usage()}\n`);
      return 0;
    }
    const context = await loadContext(parsed);
    const plan = resolveModePlan(context);
    output.write(`${JSON.stringify(plan)}\n`);
    return 0;
  } catch (error) {
    errorOutput.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
