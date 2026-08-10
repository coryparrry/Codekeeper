import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { loadVerifiedAssets } from "../src/assets.mjs";
import { MODE_IDS, MODES, RECOMMENDED_MODES, RECOMMENDED_PRESET } from "../src/constants.mjs";
import { collectAppAnswers, collectSetupAnswers } from "../src/plan.mjs";
import { createTerminalPrompter } from "../src/prompts.mjs";
import { HEAD_SHA, textSink } from "./helpers.mjs";

function terminal(answer) {
  const chunks = [];
  const input = Readable.from([answer]);
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    }
  });
  return {
    prompt: createTerminalPrompter({ input, output }),
    transcript: () => chunks.join("")
  };
}

function snapshot() {
  return Object.freeze({
    root: "/tmp/widget",
    repository: "acme/widget",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    viewerLogin: "cory",
    displayName: "widget"
  });
}

function setupPrompt({ recommended, modes = ["issues", "fix"], preset = "mixed", boundaries = true }) {
  const calls = [];
  return {
    calls,
    async confirm(options) {
      calls.push({ method: "confirm", options });
      if (options.message.startsWith("Install into") || options.message.startsWith("Edit Codekeeper in")) return true;
      if (options.message === "Use the recommended starter setup?") return recommended;
      if (options.message === "Enable OpenAI traces?") return true;
      if (options.message.startsWith("Start Codekeeper")) return true;
      if (options.message.startsWith("Continue with")) return boundaries;
      throw new Error(`Unexpected confirmation: ${options.message}`);
    },
    async multiselect(options) {
      calls.push({ method: "multiselect", options });
      if (options.message.startsWith("Choose capabilities")) return options.defaultValues;
      return modes;
    },
    async select(options) {
      calls.push({ method: "select", options });
      if (options.message === "Choose the starting model set:") return preset;
      return options.defaultValue;
    },
    async inputText(options) {
      calls.push({ method: "inputText", options });
      return options.defaultValue;
    }
  };
}

test("blank terminal confirmation accepts the recommended yes default", async () => {
  const { prompt, transcript } = terminal("\n");
  assert.equal(await prompt.confirm({ message: "Use the recommended starter setup?", defaultValue: true }), true);
  assert.equal(transcript(), "Use the recommended starter setup? [Y/n]: ");
});

test("typed no overrides the recommended yes confirmation default", async () => {
  const { prompt, transcript } = terminal("n\n");
  assert.equal(await prompt.confirm({ message: "Use the recommended starter setup?", defaultValue: true }), false);
  assert.equal(transcript(), "Use the recommended starter setup? [Y/n]: ");
});

test("blank terminal custom workflow selection accepts review and maintenance defaults", async () => {
  const { prompt, transcript } = terminal("\n");
  const choices = MODE_IDS.map((mode) => ({
    value: mode,
    label: `${MODES[mode].label} — ${MODES[mode].description}`
  }));
  assert.deepEqual(await prompt.multiselect({
    message: "Choose workflows to generate:",
    choices,
    defaultValues: RECOMMENDED_MODES
  }), ["review", "maintain"]);
  assert.match(transcript(), /Choose one or more comma-separated numbers \[1, 2\]:/);
  for (const choice of choices) assert.match(transcript(), new RegExp(choice.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("typed workflow numbers select issue triage and issue fix instead of the defaults", async () => {
  const { prompt, transcript } = terminal("3,4\n");
  const choices = MODE_IDS.map((mode) => ({
    value: mode,
    label: `${MODES[mode].label} — ${MODES[mode].description}`
  }));
  assert.deepEqual(await prompt.multiselect({
    message: "Choose workflows to generate:",
    choices,
    defaultValues: RECOMMENDED_MODES
  }), ["issues", "fix"]);
  assert.match(transcript(), /Choose one or more comma-separated numbers \[1, 2\]:/);
});

test("blank terminal custom preset selection accepts the first recommended OpenAI choice", async () => {
  const { prompt, transcript } = terminal("\n");
  const choices = [
    { value: "openai", label: "openai — use OpenAI for every selected workflow (recommended)" },
    { value: "mixed", label: "mixed — use DeepSeek for issue triage and OpenAI for other workflows" }
  ];
  assert.equal(await prompt.select({
    message: "Choose the starting model set:",
    choices,
    defaultValue: "openai"
  }), "openai");
  assert.match(transcript(), /1\. openai — use OpenAI for every selected workflow.*recommended/);
  assert.match(transcript(), /2\. mixed — use DeepSeek for issue triage and OpenAI for other workflows/);
  assert.match(transcript(), /Choose one \[1\]:/);
});

test("typed preset number selects the non-default mixed preset", async () => {
  const { prompt, transcript } = terminal("2\n");
  const choices = [
    { value: "openai", label: "openai — use OpenAI for every selected workflow (recommended)" },
    { value: "mixed", label: "mixed — use DeepSeek for issue triage and OpenAI for other workflows" }
  ];
  assert.equal(await prompt.select({
    message: "Choose the starting model set:",
    choices,
    defaultValue: "openai"
  }), "mixed");
  assert.match(transcript(), /Choose one \[1\]:/);
});

test("recommended setup explains consequences and returns review plus maintenance with OpenAI", async () => {
  const bundle = await loadVerifiedAssets();
  const prompt = setupPrompt({ recommended: true });
  const output = textSink();
  const answers = await collectSetupAnswers({ prompt, snapshot: snapshot(), bundle, output });

  assert.deepEqual(answers, {
    modes: ["review", "maintain"],
    preset: "openai",
    models: {
      review: "sol-high",
      maintain: "sol-high"
    },
    tracing: true,
    displayName: "widget",
    ownerLogins: ["cory"],
    enabled: true,
    capabilities: ["repair", "autoMerge"]
  });
  assert.ok(Object.isFrozen(answers));
  assert.deepEqual(
    prompt.calls.filter((call) => call.method === "confirm").map((call) => call.options),
    [
      { message: "Install into acme/widget on default branch main?", defaultValue: false },
      { message: "Use the recommended starter setup?", defaultValue: true },
      { message: "Enable OpenAI traces?", defaultValue: true },
      { message: "Start Codekeeper after the setup pull request merges?", defaultValue: true },
      { message: "Continue with these safety settings?", defaultValue: false }
    ]
  );
  const capabilityCall = prompt.calls.find((call) => call.method === "multiselect");
  assert.equal(capabilityCall.options.message, "Choose capabilities to turn on:");
  assert.deepEqual(capabilityCall.options.defaultValues, ["repair", "autoMerge"]);
  const transcript = output.toString();
  assert.match(transcript, /Pull request review:.*comments, labels, and a blocking result/);
  assert.match(transcript, /Repository maintenance:.*manual dry run that makes no GitHub changes/);
  assert.match(transcript, /OpenAI starting models: you can assign any supported provider and model to each role/);
  assert.match(transcript, /Issue triage and issue fix are not included/);
  assert.match(transcript, /Repository repair: on/);
  assert.match(transcript, /Automatic merge: on/);
  assert.match(transcript, /installer opens a setup pull request/);
  assert.match(transcript, /OPENAI_API_KEY:/);
  assert.match(transcript, /OPENAI_TRACE_API_KEY:/);
  assert.match(transcript, /CODEKEEPER_APP_PRIVATE_KEY:/);
  assert.doesNotMatch(transcript, /DEEPSEEK_API_KEY:/);
});

test("custom setup exposes consequence labels and keeps OpenAI as the first default preset", async () => {
  const bundle = await loadVerifiedAssets();
  const prompt = setupPrompt({ recommended: false });
  const output = textSink();
  const answers = await collectSetupAnswers({ prompt, snapshot: snapshot(), bundle, output });

  assert.deepEqual(answers, {
    modes: ["issues", "fix"],
    preset: "mixed",
    models: {
      issues: "deepseek-v4-flash",
      plan: "terra-high",
      fix: "terra-high"
    },
    tracing: true,
    displayName: "widget",
    ownerLogins: ["cory"],
    enabled: true,
    capabilities: ["issueImplementation", "duplicateClosure", "autoMerge"]
  });
  const modeCall = prompt.calls.find((call) => call.method === "multiselect");
  assert.equal(modeCall.options.message, "Choose workflows to generate:");
  assert.deepEqual(modeCall.options.defaultValues, ["review", "maintain"]);
  assert.deepEqual(modeCall.options.choices, MODE_IDS.map((mode) => ({
    value: mode,
    label: `${MODES[mode].label} — ${MODES[mode].description}`
  })));
  const presetCall = prompt.calls.find((call) => call.method === "select" && call.options.message === "Choose the starting model set:");
  assert.deepEqual(presetCall.options, {
    message: "Choose the starting model set:",
    defaultValue: RECOMMENDED_PRESET,
    choices: [
      { value: "openai", label: "openai — use OpenAI for every selected workflow (recommended)" },
      { value: "mixed", label: "mixed — use DeepSeek for issue triage and OpenAI for other workflows" }
    ]
  });
  assert.match(output.toString(), /Issue triage responds to issue events/);
  assert.match(output.toString(), /You choose issue implementation separately/);
  assert.match(output.toString(), /OPENAI_API_KEY:/);
  assert.match(output.toString(), /DEEPSEEK_API_KEY:/);
});

test("an existing installation reuses its workflows, identity, and settings", async () => {
  const bundle = await loadVerifiedAssets();
  const policy = JSON.parse(bundle.contents["policies/openai.json"]);
  policy.repository.displayName = "Existing Widget";
  policy.repository.ownerLogins = ["alice", "cory"];
  policy.audit.repair.enabled = true;
  policy.merge.enabled = true;
  const prompt = setupPrompt({ recommended: true });
  const output = textSink();
  const answers = await collectSetupAnswers({
    prompt,
    bundle,
    output,
    snapshot: {
      ...snapshot(),
      installation: {
        policy,
        policySource: `${JSON.stringify(policy, null, 2)}\n`,
        modes: ["review", "maintain"],
        contents: {}
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-widget[bot]"
      },
      updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
    }
  });
  assert.deepEqual(answers, {
    modes: ["review", "maintain"],
    preset: "openai",
    models: { review: "sol-high", maintain: "sol-high" },
    tracing: true,
    displayName: "Existing Widget",
    ownerLogins: ["alice", "cory"],
    enabled: true,
    capabilities: ["repair", "autoMerge"]
  });
  assert.equal(prompt.calls.some((call) => call.options.message === "Use the recommended starter setup?"), false);
  assert.equal(prompt.calls.some((call) => call.options.message === "Choose workflows to generate:"), false);
  assert.match(output.toString(), /current GitHub App settings and existing API keys stay unchanged/);
  assert.doesNotMatch(output.toString(), /OPENAI_API_KEY:/);
});

test("GitHub App identity asks for the App name in plain language", async () => {
  const prompts = [];
  const prompt = {
    kind: "ink",
    async inputText(options) {
      prompts.push(options);
      return options.message.includes("Client ID") ? "Iv123456789012345678" : "codekeeper-widget";
    }
  };
  assert.deepEqual(await collectAppAnswers({ prompt, modes: ["review"], output: textSink() }), {
    appClientId: "Iv123456789012345678",
    automationBotLogin: "codekeeper-widget[bot]"
  });
  assert.equal(prompts[1].message, "GitHub App name from the settings URL");
  assert.match(prompts[1].description.join("\n"), /settings URL/i);
});
