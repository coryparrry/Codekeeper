import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Text,
  render as inkRender,
  useApp,
  useInput,
  usePaste,
  useStdin,
  useStdout
} from "ink";
import { InstallerError } from "./errors.mjs";
import { MODES } from "./constants.mjs";
import {
  containsPrivateKeyPemEnvelope,
  inspectPrivateKeyTextInput,
  PRIVATE_KEY_INPUT_ERROR,
  sanitizeTextInput
} from "./input-safety.mjs";
import { completionGuidance, modelAssignments, workflowMap } from "./plan.mjs";
import { createPrivateKeyPickerController } from "./private-key-input.mjs";
import { SettingsScreen } from "./settings-tui.mjs";

const h = React.createElement;
const DEFAULT_PROGRESS_STEPS = Object.freeze([
  Object.freeze({ id: "repository:verify", label: "Recheck the confirmed repository" }),
  Object.freeze({ id: "git:commit", label: "Create and verify the setup commit" }),
  Object.freeze({ id: "git:push", label: "Push the setup branch" }),
  Object.freeze({ id: "secret:provider", label: "Store API keys" }),
  Object.freeze({ id: "secret:app", label: "Store the GitHub App key safely" }),
  Object.freeze({ id: "variables:configure", label: "Set non-secret repository variables" }),
  Object.freeze({ id: "settings:disable", label: "Apply the startup choice last" }),
  Object.freeze({ id: "github:pull-request", label: "Open the setup pull request" })
]);

const NOTICE_SINK = Object.freeze({ write: () => true });

function installerCancelled() {
  return new InstallerError("Interactive setup was cancelled.", { code: "PROMPT_ABORTED" });
}

export function shouldUseInkTui({
  interactive,
  input,
  output,
  environment = process.env
} = {}) {
  return interactive === true
    && input?.isTTY === true
    && output?.isTTY === true
    && typeof input?.setRawMode === "function"
    && String(environment?.TERM ?? "").toLowerCase() !== "dumb";
}

function colorProps(enabled, color) {
  return enabled ? { color } : {};
}

function useSpinner(active = true) {
  const frames = ["◐", "◓", "◑", "◒"];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = globalThis.setInterval(() => setIndex((value) => (value + 1) % frames.length), 120);
    return () => globalThis.clearInterval(timer);
  }, [active, frames.length]);
  return frames[index];
}

function fitText(value, width) {
  const text = String(value).replace(/\s*\n\s*/g, " ↵ ");
  if ([...text].length <= width) return text;
  return `${[...text].slice(0, Math.max(1, width - 1)).join("")}…`;
}

function DetailLines({ lines = [] }) {
  return h(
    Box,
    { flexDirection: "column", marginTop: lines.length ? 1 : 0 },
    ...lines.map((line, index) => h(Text, { key: `${index}-${line}`, dimColor: true }, line))
  );
}

function Shell({ step, title, description = [], footer, colorEnabled, compactDetail = false, children }) {
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const compact = Number.isFinite(stdout?.columns) && stdout.columns <= 40;
  return h(
    Box,
    { flexDirection: "column", paddingX: compact ? 0 : 1 },
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: compact || compactDetail ? undefined : "round",
        borderColor: colorEnabled ? "cyan" : undefined,
        paddingX: compact ? 0 : 2,
        paddingY: compact || compactDetail ? 0 : 1,
        width: "100%"
      },
      h(
        Box,
        compact ? { flexDirection: "column" } : { justifyContent: "space-between" },
        h(Text, { bold: true, ...colorProps(colorEnabled, "cyan") }, "CODEKEEPER"),
        step ? h(Text, { bold: true, ...colorProps(colorEnabled, "magenta") }, step.toUpperCase()) : null
      ),
      h(Text, { bold: true }, title),
      h(DetailLines, { lines: description }),
      h(Box, { flexDirection: "column", marginTop: 1 }, children),
      h(
        Box,
        { marginTop: 1 },
        h(Text, { ...colorProps(colorEnabled, "cyan") }, isRawModeSupported ? footer : "This terminal does not support keyboard input. Run the installer in an interactive terminal.")
      )
    )
  );
}

function useCancel(onCancel) {
  return useCallback((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === "c")) onCancel(installerCancelled());
  }, [onCancel]);
}

function useCurrentState(initialValue) {
  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(value);
  const setCurrentValue = useCallback((nextValue) => {
    valueRef.current = typeof nextValue === "function" ? nextValue(valueRef.current) : nextValue;
    setValue(valueRef.current);
  }, []);
  return [value, setCurrentValue, valueRef];
}

function ConfirmScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [selected, setSelected, selectedRef] = useCurrentState(Boolean(spec.defaultValue));
  const cancel = useCancel(onCancel);
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.leftArrow || key.upArrow || input === "h" || input === "k") setSelected(true);
    if (key.rightArrow || key.downArrow || input === "l" || input === "j" || key.tab) setSelected(false);
    if (input.toLowerCase() === "y") setSelected(true);
    if (input.toLowerCase() === "n") setSelected(false);
    if (key.return) onSubmit(selectedRef.current);
  });
  return h(
    Shell,
    {
      step: spec.step,
      title: spec.message,
      description: spec.description,
      footer: "←/→ choose  •  Enter continue  •  Esc cancel",
      colorEnabled
    },
    h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: selected, inverse: selected }, `${selected ? "›" : " "} ${spec.yesLabel ?? "Yes"}`),
      h(Text, { bold: !selected, inverse: !selected }, `${!selected ? "›" : " "} ${spec.noLabel ?? "No"}`)
    )
  );
}

function SelectScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const defaultIndex = Math.max(0, spec.choices.findIndex((choice) => choice.value === spec.defaultValue));
  const [index, setIndex, indexRef] = useCurrentState(defaultIndex);
  const cancel = useCancel(onCancel);
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.upArrow || input === "k") setIndex((value) => (value - 1 + spec.choices.length) % spec.choices.length);
    if (key.downArrow || input === "j" || key.tab) setIndex((value) => (value + 1) % spec.choices.length);
    if (key.return) onSubmit(spec.choices[indexRef.current].value);
  });
  return h(
    Shell,
    {
      step: spec.step,
      title: spec.message,
      description: spec.description,
      footer: "↑/↓ move  •  Enter select  •  Esc cancel",
      colorEnabled
    },
    h(
      Box,
      { flexDirection: "column" },
      ...spec.choices.map((choice, choiceIndex) => h(
        Text,
        {
          key: choice.value,
          bold: choiceIndex === index,
          ...colorProps(colorEnabled && choiceIndex === index, "cyan")
        },
        `${choiceIndex === index ? "›" : " "} ${choiceIndex === index ? "●" : "○"} ${choice.label}`
      ))
    )
  );
}

function MultiSelectScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [index, setIndex, indexRef] = useCurrentState(0);
  const [selected, setSelected, selectedRef] = useCurrentState(() => new Set(spec.defaultValues ?? []));
  const [error, setError] = useState("");
  const cancel = useCancel(onCancel);
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.upArrow || input === "k") setIndex((value) => (value - 1 + spec.choices.length) % spec.choices.length);
    if (key.downArrow || input === "j" || key.tab) setIndex((value) => (value + 1) % spec.choices.length);
    if (input === " ") {
      setSelected((current) => {
        const next = new Set(current);
        const value = spec.choices[indexRef.current].value;
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
      setError("");
    }
    if (key.return) {
      const values = spec.choices.filter((choice) => selectedRef.current.has(choice.value)).map((choice) => choice.value);
      if (!values.length && !spec.allowEmpty) setError("Select at least one workflow.");
      else onSubmit(values);
    }
  });
  return h(
    Shell,
    {
      step: spec.step,
      title: spec.message,
      description: spec.description,
      footer: "↑/↓ move  •  Space toggle  •  Enter continue  •  Esc cancel",
      colorEnabled
    },
    h(
      Box,
      { flexDirection: "column" },
      ...spec.choices.map((choice, choiceIndex) => h(
        Text,
        {
          key: choice.value,
          bold: choiceIndex === index,
          ...colorProps(colorEnabled && choiceIndex === index, "cyan")
        },
        `${choiceIndex === index ? "›" : " "} [${selected.has(choice.value) ? "✓" : " "}] ${choice.label}`
      )),
      error ? h(Text, { color: colorEnabled ? "red" : undefined }, error) : null
    )
  );
}

function TextInputScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [value, setValue, valueRef] = useCurrentState("");
  const [error, setError] = useState("");
  const pendingPemMarkerRef = useRef("");
  const pemInputBlockedRef = useRef(false);
  const cancel = useCancel(onCancel);
  const append = useCallback((text) => {
    if (pemInputBlockedRef.current) return false;
    const inspected = inspectPrivateKeyTextInput(pendingPemMarkerRef.current, text);
    pendingPemMarkerRef.current = inspected.pending;
    if (inspected.blocked) {
      pemInputBlockedRef.current = true;
      setError(PRIVATE_KEY_INPUT_ERROR);
      return false;
    }
    if (inspected.visible) {
      setValue((current) => `${current}${inspected.visible}`.slice(0, spec.maxLength ?? 256));
    }
    return true;
  }, [spec.maxLength]);
  const paste = useCallback((text) => {
    if (append(text)) setError("");
  }, [append]);
  usePaste(paste);
  useInput((input, key) => {
    cancel(input, key);
    if (key.return) {
      if (pemInputBlockedRef.current) {
        setError(PRIVATE_KEY_INPUT_ERROR);
        return;
      }
      const typedValue = `${valueRef.current}${pendingPemMarkerRef.current}`;
      const candidate = typedValue || spec.defaultValue || "";
      const validation = spec.validate(candidate);
      if (validation === true) onSubmit(candidate);
      else setError(typeof validation === "string" ? validation : "Enter a valid value.");
      return;
    }
    if (key.backspace || key.delete) {
      if (pemInputBlockedRef.current) {
        setError(PRIVATE_KEY_INPUT_ERROR);
        return;
      }
      if (pendingPemMarkerRef.current) pendingPemMarkerRef.current = pendingPemMarkerRef.current.slice(0, -1);
      else {
        setValue((current) => current.slice(0, -1));
      }
      setError("");
      return;
    }
    if (key.ctrl && input.toLowerCase() === "u") {
      pendingPemMarkerRef.current = "";
      pemInputBlockedRef.current = false;
      setValue("");
      setError("");
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      if (append(input)) setError("");
    }
  });
  const shown = value || spec.defaultValue || "";
  return h(
    Shell,
    {
      step: spec.step,
      title: spec.message,
      description: spec.description,
      footer: "Type a value  •  Enter continue  •  Ctrl-U clear  •  Esc cancel",
      colorEnabled
    },
    h(
      Box,
      { borderStyle: "single", paddingX: 1 },
      h(Text, { dimColor: !value }, shown),
      h(Text, { ...colorProps(colorEnabled, "cyan") }, "▌")
    ),
    error ? h(Text, { color: colorEnabled ? "red" : undefined }, error) : null
  );
}

function SecretInputScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [received, setReceived, receivedRef] = useCurrentState(false);
  const [error, setError] = useState("");
  const cancel = useCancel(onCancel);
  const accept = useCallback((text) => {
    if (receivedRef.current) {
      setError("Secret already received. Press Enter to save it, or Esc to cancel and restart.");
      return;
    }
    const safe = sanitizeTextInput(text);
    if (!safe) return;
    if (containsPrivateKeyPemEnvelope(safe)) {
      setError(PRIVATE_KEY_INPUT_ERROR);
      return;
    }
    try {
      spec.write(safe);
      setReceived(true);
      setError("");
    } catch {
      setError("The credential failed to send safely. Cancel the setup and try again.");
    }
  }, [spec]);
  usePaste(accept);
  useInput((input, key) => {
    cancel(input, key);
    if (key.return) {
      if (receivedRef.current) onSubmit(true);
      else setError("Paste the credential before continuing.");
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setError("Paste the complete credential as one value before continuing.");
    }
  });
  return h(
    Shell,
    {
      step: spec.step,
      title: spec.name,
      description: [
        spec.purpose,
        "Paste the single-line key here. Codekeeper sends it directly to GitHub CLI. Codekeeper does not display or store it."
      ],
      footer: "Paste key  •  Enter save  •  Esc cancel",
      colorEnabled
    },
    h(Text, { bold: received, ...colorProps(colorEnabled && received, "green") }, received ? "Key received. Press Enter to save." : "Waiting for a pasted key..."),
    error ? h(Text, { color: colorEnabled ? "red" : undefined }, error) : null
  );
}

function FilePickerScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [listing, setListing] = useState(null);
  const [index, setIndex, indexRef] = useCurrentState(0);
  const [error, setError] = useState("");
  const activationRef = useRef(0);
  const cancel = useCancel(onCancel);
  usePaste(() => {});
  useEffect(() => {
    let live = true;
    setListing(null);
    setError("");
    spec.picker.list()
      .then((next) => {
        if (!live) return;
        setListing(next);
        setIndex(0);
      })
      .catch(() => {
        if (!live) return;
        setError("The picker failed to open that folder safely.");
      });
    return () => { live = false; };
  }, [spec]);
  const choices = listing?.choices ?? [];
  useInput((input, key) => {
    cancel(input, key);
    if (!choices.length) return;
    if (key.upArrow || input === "k") setIndex((value) => (value - 1 + choices.length) % choices.length);
    if (key.downArrow || input === "j" || key.tab) setIndex((value) => (value + 1) % choices.length);
    if (key.return) {
      const choice = choices[indexRef.current];
      if (!choice) return;
      const activation = ++activationRef.current;
      spec.picker.activate(choice.id).then((result) => {
        if (activation !== activationRef.current) return;
        if (result.selected) onSubmit(result.value);
        else if (result.listing) {
          setListing(result.listing);
          setIndex(0);
          setError("");
        }
      }).catch(() => {
        if (activation !== activationRef.current) return;
        setError("The picker failed to open that item safely.");
      });
    }
  });
  return h(
    Shell,
    {
      step: spec.step,
      title: "Choose the downloaded GitHub App key",
      description: [
        "Open folders to find the downloaded .pem key. The newest key files are first.",
        "Other files and links are hidden. The picker does not open the key or display its path."
      ],
      footer: "↑/↓ move  •  Enter select  •  Esc cancel",
      colorEnabled
    },
    h(Text, { bold: true }, `Keys in ${listing?.folderLabel ?? "Loading…"}`),
    error ? h(Text, { color: colorEnabled ? "red" : undefined }, error) : null,
    !error && !listing ? h(Text, { dimColor: true }, "Finding key files...") : null,
    listing && !choices.length ? h(Text, { dimColor: true }, `No usable .pem keys or folders found in ${listing.folderLabel}. Download a new GitHub App key, then retry.`) : null,
    h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      ...choices.slice(Math.max(0, index - 5), Math.max(0, index - 5) + 11).map((choice) => {
        const choiceIndex = choices.indexOf(choice);
        return h(
          Text,
          {
            key: choice.id,
            bold: choiceIndex === index,
            ...colorProps(colorEnabled && choiceIndex === index, "cyan")
          },
          `${choiceIndex === index ? "›" : " "} key  ${choice.label}`
        );
      })
    )
  );
}

function DoctorScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const cancel = useCancel(onCancel);
  const { stdout } = useStdout();
  const compact = (stdout?.rows ?? 24) < 32;
  const lineWidth = Math.max(24, (stdout?.columns ?? 80) - 8);
  const problems = spec.report.checks.filter((check) => check.status !== "pass");
  const checks = compact && problems.length
    ? problems
    : spec.report.checks;
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.return) onSubmit(spec.report.mutationAllowed);
  });
  return h(
    Shell,
    {
      step: "doctor",
      title: "Repository readiness",
      description: [spec.report.mutationAllowed
        ? "Every blocking prerequisite passed. Warnings still need your attention."
        : "Fix every failed item before Codekeeper can continue."],
      footer: `${spec.report.mutationAllowed ? "Enter continue" : "Enter close"}  •  Esc cancel`,
      colorEnabled,
      compactDetail: compact
    },
    ...checks.map((check) => {
      const symbol = check.status === "pass" ? "✓" : check.status === "warning" ? "⚠" : check.status === "skipped" ? "·" : "✕";
      const color = check.status === "pass" ? "green" : check.status === "warning" ? "yellow" : check.status === "fail" ? "red" : undefined;
      return h(Text, { key: check.id, ...colorProps(colorEnabled, color) }, fitText(`${symbol} ${check.label}: ${check.detail}`, lineWidth));
    }),
    compact && problems.length
      ? h(Text, { dimColor: true }, `${spec.report.counts.pass} additional checks passed.`)
      : null,
    h(Text, { bold: true }, `${spec.report.counts.pass} passed · ${spec.report.counts.warning} warnings · ${spec.report.counts.fail} failed`)
  );
}

function reviewData(plan) {
  const canModifyFiles = plan.capabilities.reviewRepair
    || plan.capabilities.repair
    || plan.capabilities.issueImplementation;
  const state = (enabled) => enabled ? "ON" : "OFF";
  return {
    repository: `${plan.repository} · ${plan.defaultBranch}`,
    identity: `${plan.displayName} · owners: ${plan.ownerLogins.join(", ")}`,
    workflows: [
      "Repository assistant — configured-owner comments",
      ...workflowMap(plan.modes, { maintenanceScheduled: plan.maintenanceScheduled })
        .map((item) => `${item.label} — ${item.trigger}`)
    ],
    authority: [
      `${state(plan.enabled && plan.modes.includes("review") && plan.policy.automation.automaticPrReview)}  Review eligible pull requests automatically`,
      `${state(plan.enabled && plan.modes.includes("review"))}  Post comments, labels, and a blocking result`,
      `${state(plan.enabled && plan.modes.includes("maintain") && plan.maintenanceScheduled)}  Scheduled maintenance`,
      `${state(canModifyFiles)}  Modify repository files`,
      `${state(plan.capabilities.issueImplementation)}  Implement issues`,
      `${state(plan.capabilities.autoMerge)}  Merge pull requests`,
      `${state(plan.tracing)}  OpenAI tracing`
    ],
    models: modelAssignments(plan.modes).flatMap(({ key, label }) => {
      const summary = plan.modelSummary[key];
      const coordinator = `${label}: ${summary.coordinator.model} · ${summary.coordinator.effort}`;
      if (!summary.workspace.enabled) return [coordinator, `${label} workspace: off`];
      return [
        coordinator,
        `${label} workspace: ${summary.workspace.model} · ${summary.workspace.effort} · ${summary.workspace.allowWrites ? "write-enabled" : "read-only"}`
      ];
    }),
    documentCount: plan.files.length,
    secrets: plan.secrets.map((secret) => secret.name),
    variables: plan.variables.map((variable) => variable.name),
    app: ["Contents: read/write", "Issues: read/write", "Pull requests: read/write", "Metadata: read-only", `Requested access: ${plan.repository} only`],
    repair: `${(plan.policy.audit.repair.allowedPaths ?? []).length} allowed path rules · ${(plan.policy.audit.repair.protectedPaths ?? []).length} protected path rules`,
    validation: plan.policy.audit.repair.validationCommands ?? [],
    startup: plan.update && plan.enabled
      ? "Codekeeper starts now with the current settings. This update applies after merge."
      : plan.enabled ? "Codekeeper starts after merge." : "Codekeeper stays off after merge.",
  };
}

function operationCopy(plan) {
  if (plan.operation === "release-update") {
    return {
      noun: "release update",
      completionTitle: "Update ready",
      description: "Review the release-owned files and settings that will advance."
    };
  }
  if (plan.operation === "configuration-update") {
    return {
      noun: "settings update",
      completionTitle: "Settings update ready",
      description: "Review the repository settings that will change."
    };
  }
  return {
    noun: "setup",
    completionTitle: "Setup pull request ready",
    description: "The App key is selected. Its path and contents stay hidden."
  };
}

function ReviewScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [selection, setSelection, selectionRef] = useCurrentState(0);
  const cancel = useCancel(onCancel);
  const data = useMemo(() => reviewData(spec.plan), [spec.plan]);
  const operation = operationCopy(spec.plan);
  const { stdout } = useStdout();
  const compactDetail = (stdout?.rows ?? 24) < 42 || (stdout?.columns ?? 80) < 60;
  const short = (stdout?.rows ?? 24) < 30;
  const lineWidth = Math.max(20, (stdout?.columns ?? 80) - (compactDetail ? 6 : 10));
  const choices = [
    { value: true, label: `Create the ${operation.noun} pull request` },
    { value: "settings", label: "Back to settings" },
    { value: false, label: "Cancel" }
  ];
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.upArrow || key.leftArrow || input === "k" || input === "h") setSelection((value) => (value - 1 + choices.length) % choices.length);
    if (key.downArrow || key.rightArrow || input === "j" || input === "l" || key.tab) setSelection((value) => (value + 1) % choices.length);
    if (key.return) onSubmit(choices[selectionRef.current].value);
  });
  const workflowSummary = data.workflows.join(" · ");
  const authoritySummary = data.authority.join(" · ");
  const modelSummary = data.models.join(" · ");
  return h(
    Shell,
    {
      step: "final review",
      title: `Review the ${operation.noun}`,
      description: short ? [] : ["Nothing has changed yet. Check the essentials or return to settings."],
      footer: "Arrow keys choose  •  Enter continue  •  Esc cancel",
      colorEnabled,
      compactDetail
    },
    h(Text, { bold: true, ...colorProps(colorEnabled, "cyan") }, fitText(`${data.repository}  •  ${data.identity}`, lineWidth)),
    h(Text, { dimColor: true }, fitText(`⚡ ${workflowSummary}`, lineWidth)),
    h(Text, { bold: true }, "AFTER MERGE"),
    compactDetail
      ? h(Text, { dimColor: true }, fitText(authoritySummary, lineWidth))
      : data.authority.map((item, index) => h(Text, { key: `authority-${index}`, dimColor: true }, fitText(`  ${item}`, lineWidth))),
    h(Text, { bold: true }, "MODELS"),
    compactDetail
      ? h(Text, { dimColor: true }, fitText(modelSummary, lineWidth))
      : data.models.map((model, index) => h(Text, { key: `model-${index}`, dimColor: true }, fitText(`  ${model}`, lineWidth))),
    h(Text, { bold: true }, "APP AUTHORITY REQUESTED"),
    h(Text, { dimColor: true }, fitText(`  ${data.app.join(" · ")}`, lineWidth)),
    h(Text, { dimColor: true }, fitText(`  Repair: ${data.repair} · Validate: ${data.validation.join(" · ")}`, lineWidth)),
    h(Text, { dimColor: true }, fitText(`CREDENTIALS  ${data.secrets.length} created/replaced: ${data.secrets.join(", ") || "none"}`, lineWidth)),
    h(Text, { dimColor: true }, fitText(`VARIABLES  ${data.variables.length} created/replaced: ${data.variables.join(", ") || "none"}`, lineWidth)),
    h(Text, { dimColor: true }, fitText(`FILES  ${data.documentCount} changes · ${data.startup}`, lineWidth)),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...choices.map((choice, choiceIndex) => h(Text, {
        key: String(choice.value),
        bold: choiceIndex === selection,
        inverse: choiceIndex === selection,
        ...colorProps(colorEnabled && choiceIndex === selection, "cyan")
      }, `${choiceIndex === selection ? "›" : " "} ${choice.label}`))
    )
  );
}

function ProgressScreen({ state, colorEnabled }) {
  const statuses = new Map(state.events.map((event) => [event.id, event]));
  const spinner = useSpinner(state.events.some((event) => event.status === "active"));
  const completed = state.steps.filter((step) => statuses.get(step.id)?.status === "done").length;
  const progressWidth = 16;
  const filled = Math.round((completed / state.steps.length) * progressWidth);
  return h(
    Shell,
    {
      step: "installing",
      title: "Creating the Codekeeper pull request",
      description: ["Keep this terminal open until the pull request is ready."],
      footer: state.paused ? "GitHub CLI has the terminal. Complete its secret prompt to return." : "Please keep this terminal open.",
      colorEnabled
    },
    h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true, ...colorProps(colorEnabled, "cyan") }, `[${"█".repeat(filled)}${"░".repeat(progressWidth - filled)}] ${completed}/${state.steps.length}`),
      ...state.steps.map((step) => {
        const event = statuses.get(step.id) ?? { status: "pending" };
        const symbol = event.status === "done" ? "✓" : event.status === "active" ? spinner : event.status === "failed" ? "✕" : "·";
        const color = event.status === "done" ? "green" : event.status === "failed" ? "red" : event.status === "active" ? "cyan" : undefined;
        return h(
          Text,
          { key: step.id, bold: event.status === "active", ...colorProps(colorEnabled, color) },
          `${symbol} ${step.label}${event.detail ? ` — ${event.detail}` : ""}`
        );
      })
    )
  );
}

function CompletionScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const cancel = useCancel(onCancel);
  const { stdout } = useStdout();
  const compact = Number.isFinite(stdout?.rows) && stdout.rows < 30;
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.return) onSubmit(true);
  });
  const guidance = completionGuidance(spec.plan.modes, spec.plan.enabled, spec.plan.update);
  const operation = operationCopy(spec.plan);
  const completedSteps = spec.receipt.settingsOnly
    ? DEFAULT_PROGRESS_STEPS.filter((step) => ["repository:verify", "secret:provider", "secret:app", "variables:configure", "settings:disable"].includes(step.id))
    : DEFAULT_PROGRESS_STEPS;
  return h(
    Shell,
    {
      step: "complete",
      title: operation.completionTitle,
      description: spec.receipt.settingsOnly
        ? ["No pull request was needed."]
        : [
          spec.receipt.pullRequestOpened
            ? "The pull request opened in your browser."
            : "Open the pull request with the link below.",
          spec.receipt.pullRequestUrl
        ],
      footer: "Enter finish  •  Esc close",
      colorEnabled
    },
    h(
      Box,
      { flexDirection: "column" },
      ...completedSteps.map((step) => h(Text, { key: step.id, dimColor: true }, `✓ ${step.label}`)),
      compact ? null : h(Text, { dimColor: true }, `Release: Codekeeper ${spec.plan.packageVersion} · ${spec.plan.source.repository}@${spec.plan.source.commit}`),
      h(Text, { dimColor: true }, spec.receipt.settingsOnly
        ? "Repository settings were updated; readiness is not yet proven."
        : "The setup is not active or proven until its pull request merges."),
      compact ? null : h(Text, { dimColor: true }, `OpenAI traces: ${spec.plan.tracing ? "enabled" : "disabled"}.`),
      !compact && guidance.reviewGateWarning ? h(Text, { dimColor: true }, guidance.reviewGateWarning) : null,
      h(Text, { dimColor: true }, compact ? "After merge, run codekeeper verify." : guidance.closing)
    )
  );
}

function IdleScreen({ colorEnabled }) {
  const spinner = useSpinner();
  return h(
    Shell,
    {
      step: "preparing",
      title: "Codekeeper guided setup",
      description: ["Checking the installer and repository before anything can change."],
      footer: `${spinner} Please wait…`,
      colorEnabled
    },
    h(Text, { dimColor: true }, "🔒 Setup questions do not change the repository.")
  );
}

function TuiRoot({ registerController, colorEnabled }) {
  const [screen, setScreen] = useState({ kind: "idle" });
  const pendingRef = useRef(null);
  const screenIdRef = useRef(0);
  const { exit, suspendTerminal } = useApp();

  const present = useCallback((spec) => new Promise((resolve, reject) => {
    if (pendingRef.current) {
      reject(new InstallerError("The installer tried to show two interactive screens at once.", { code: "PROMPT_INVALID" }));
      return;
    }
    screenIdRef.current += 1;
    const screenId = screenIdRef.current;
    pendingRef.current = { resolve, reject, screenId };
    setScreen({ ...spec, screenId });
  }), []);
  const settle = useCallback((screenId, value, error) => {
    const pending = pendingRef.current;
    if (!pending || pending.screenId !== screenId) return;
    pendingRef.current = null;
    if (error) pending.reject(error);
    else pending.resolve(value);
  }, []);
  const close = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) pending.reject(installerCancelled());
    exit();
  }, [exit]);

  useEffect(() => {
    registerController(Object.freeze({
      present,
      setProgress: (state) => setScreen({ kind: "progress", state }),
      suspendTerminal,
      close
    }));
  }, [close, present, registerController, suspendTerminal]);

  const common = {
    key: screen.screenId,
    spec: screen,
    onSubmit: (value) => settle(screen.screenId, value),
    onCancel: screen.kind === "completion"
      ? () => settle(screen.screenId, true)
      : (error) => settle(screen.screenId, null, error),
    colorEnabled
  };
  if (screen.kind === "confirm") return h(ConfirmScreen, common);
  if (screen.kind === "select") return h(SelectScreen, common);
  if (screen.kind === "multiselect") return h(MultiSelectScreen, common);
  if (screen.kind === "input") return h(TextInputScreen, common);
  if (screen.kind === "secret") return h(SecretInputScreen, common);
  if (screen.kind === "file") return h(FilePickerScreen, common);
  if (screen.kind === "doctor") return h(DoctorScreen, common);
  if (screen.kind === "settings") return h(SettingsScreen, common);
  if (screen.kind === "review") return h(ReviewScreen, common);
  if (screen.kind === "completion") return h(CompletionScreen, common);
  if (screen.kind === "progress") return h(ProgressScreen, { state: screen.state, colorEnabled });
  return h(IdleScreen, { colorEnabled });
}

export function createInkProgress({ session, steps = DEFAULT_PROGRESS_STEPS } = {}) {
  if (!session || typeof session.setProgress !== "function" || typeof session.suspendTerminal !== "function") {
    throw new TypeError("createInkProgress requires an Ink installer session");
  }
  let state = {
    steps: steps.map((step) => ({ ...step })),
    events: [],
    paused: false
  };
  const publish = () => session.setProgress({ ...state, events: state.events.map((event) => ({ ...event })) });
  const update = (event) => {
    if (!event || !steps.some((step) => step.id === event.id)) return;
    const byId = new Map(state.events.map((item) => [item.id, item]));
    byId.set(event.id, { ...byId.get(event.id), ...event });
    state = { ...state, events: [...byId.values()] };
    publish();
  };
  return Object.freeze({
    start() {
      state = { ...state, events: [], paused: false };
      publish();
    },
    update,
    async suspend(callback, notice) {
      state = { ...state, paused: true };
      publish();
      await session.waitUntilRenderFlush?.();
      try {
        return await session.suspendTerminal(async () => {
          if (notice) session.writeSuspendedNotice?.(notice);
          return callback();
        });
      } finally {
        state = { ...state, paused: false };
        publish();
      }
    },
    fail(id, detail = "Setup stopped") {
      update({ id, status: "failed", detail });
    }
  });
}

export async function createInkPrompter({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  environment = process.env,
  renderImpl = inkRender,
  fsImpl,
  homeDirectory
} = {}) {
  let controller;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const registerController = (value) => {
    controller = value;
    resolveReady(value);
  };
  const colorEnabled = environment.NO_COLOR === undefined;
  const instance = renderImpl(
    h(TuiRoot, { registerController, colorEnabled }),
    {
      stdin: input,
      stdout: output,
      stderr: errorOutput,
      interactive: true,
      exitOnCtrlC: false,
      alternateScreen: true,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" }
    }
  );
  const session = await ready;
  const progress = createInkProgress({
    session: {
      ...session,
      waitUntilRenderFlush: () => instance.waitUntilRenderFlush(),
      writeSuspendedNotice(notice) {
        if (typeof notice?.name !== "string" || typeof notice?.purpose !== "string") return;
        output.write(`\nCodekeeper credential\n${notice.name} — ${notice.purpose}\nEnter this value only in the GitHub CLI prompt below. An existing same-named secret is deliberately replaced only after you enter its new value.\n`);
      }
    }
  });
  let disposed = false;
  const present = (kind, spec) => session.present({ kind, ...spec });

  return Object.freeze({
    kind: "ink",
    input,
    output,
    notices: NOTICE_SINK,
    progress,
    async inputText(spec) {
      return present("input", spec);
    },
    async inputSecret(spec) {
      return present("secret", spec);
    },
    async confirm(spec) {
      return present("confirm", spec);
    },
    async select(spec) {
      return present("select", spec);
    },
    async multiselect(spec) {
      return present("multiselect", spec);
    },
    async showDoctor(report) {
      return present("doctor", { report });
    },
    async editSettings(spec) {
      return present("settings", spec);
    },
    async selectPrivateKey({ step = "private key" } = {}) {
      const picker = await createPrivateKeyPickerController({
        ...(fsImpl ? { fsImpl } : {}),
        ...(homeDirectory ? { homeDirectory } : {})
      });
      return present("file", {
        step,
        picker
      });
    },
    async reviewInstallPlan(plan) {
      return present("review", { plan });
    },
    async showCompletion(plan, receipt) {
      return present("completion", { plan, receipt });
    },
    suspendTerminal(callback, notice) {
      return progress.suspend(callback, notice);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const exited = instance.waitUntilExit();
      session.close();
      try {
        await exited;
      } catch {
        // The caller reports the original installer error after terminal cleanup.
      } finally {
        instance.cleanup();
      }
    }
  });
}

export { DEFAULT_PROGRESS_STEPS };
export { containsPrivateKeyPemEnvelope, sanitizeTextInput };
export {
  createPrivateKeyPickerController,
  defaultPrivateKeyDirectory,
  listPrivateKeyChoices
} from "./private-key-input.mjs";
