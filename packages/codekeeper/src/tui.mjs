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
import { CONSERVATIVE_BOUNDARIES, MODES, SECRET_PURPOSES } from "./constants.mjs";
import { capabilitySummary, completionGuidance, documentMap, workflowMap } from "./plan.mjs";
import { createPrivateKeyPickerController } from "./private-key-input.mjs";

const h = React.createElement;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const PRIVATE_KEY_PEM_ENVELOPE = /-----(?:BEGIN|END) (?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY-----/i;
const PEM_MARKER_STARTS = Object.freeze(["-----BEGIN", "-----END"]);
const PRIVATE_KEY_INPUT_ERROR = "Private keys cannot be pasted here. Press Ctrl-U, then select the downloaded .pem file at the private-key step.";
const DEFAULT_PROGRESS_STEPS = Object.freeze([
  Object.freeze({ id: "repository:verify", label: "Recheck the confirmed repository" }),
  Object.freeze({ id: "settings:disable", label: "Set the startup choice" }),
  Object.freeze({ id: "secret:provider", label: "Store API keys" }),
  Object.freeze({ id: "secret:app", label: "Store the GitHub App key safely" }),
  Object.freeze({ id: "variables:configure", label: "Set non-secret repository variables" }),
  Object.freeze({ id: "git:commit", label: "Create and verify the setup commit" }),
  Object.freeze({ id: "git:push", label: "Push the setup branch" }),
  Object.freeze({ id: "github:pull-request", label: "Open the setup pull request" })
]);

const NOTICE_SINK = Object.freeze({ write: () => true });

function installerCancelled() {
  return new InstallerError("Interactive setup was cancelled.", { code: "PROMPT_ABORTED" });
}

export function sanitizeTextInput(value) {
  return String(value ?? "").replace(CONTROL_CHARACTERS, "");
}

export function containsPrivateKeyPemEnvelope(value) {
  return PRIVATE_KEY_PEM_ENVELOPE.test(String(value ?? ""));
}

function pendingPemMarkerLength(value) {
  const upper = value.toUpperCase();
  let pendingLength = 0;
  for (const marker of PEM_MARKER_STARTS) {
    const limit = Math.min(upper.length, marker.length - 1);
    for (let length = 1; length <= limit; length += 1) {
      if (upper.endsWith(marker.slice(0, length))) pendingLength = Math.max(pendingLength, length);
    }
  }
  return pendingLength;
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

function usesPagedDetailLayout(stdout) {
  const roomyWidth = Number.isFinite(stdout?.columns) && stdout.columns >= 100;
  const roomyHeight = Number.isFinite(stdout?.rows) && stdout.rows >= 40;
  return !(roomyWidth && roomyHeight);
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
        step ? h(Text, { dimColor: true }, step.toUpperCase()) : null
      ),
      h(Text, { bold: true }, title),
      h(DetailLines, { lines: description }),
      h(Box, { flexDirection: "column", marginTop: 1 }, children),
      h(
        Box,
        { marginTop: 1 },
        h(Text, { dimColor: true }, isRawModeSupported ? footer : "This terminal does not support keyboard input. Run the installer in an interactive terminal.")
      )
    )
  );
}

function useCancel(onCancel) {
  return useCallback((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === "c")) onCancel(installerCancelled());
  }, [onCancel]);
}

function ConfirmScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [selected, setSelected] = useState(Boolean(spec.defaultValue));
  const cancel = useCancel(onCancel);
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.leftArrow || key.upArrow || input === "h" || input === "k") setSelected(true);
    if (key.rightArrow || key.downArrow || input === "l" || input === "j" || key.tab) setSelected(false);
    if (input.toLowerCase() === "y") setSelected(true);
    if (input.toLowerCase() === "n") setSelected(false);
    if (key.return) onSubmit(selected);
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
  const [index, setIndex] = useState(defaultIndex);
  const cancel = useCancel(onCancel);
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (key.upArrow || input === "k") setIndex((value) => (value - 1 + spec.choices.length) % spec.choices.length);
    if (key.downArrow || input === "j" || key.tab) setIndex((value) => (value + 1) % spec.choices.length);
    if (key.return) onSubmit(spec.choices[index].value);
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
        `${choiceIndex === index ? "›" : " "} ${choice.label}`
      ))
    )
  );
}

function MultiSelectScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(() => new Set(spec.defaultValues ?? []));
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
        const value = spec.choices[index].value;
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
      setError("");
    }
    if (key.return) {
      const values = spec.choices.filter((choice) => selected.has(choice.value)).map((choice) => choice.value);
      if (!values.length) setError("Select at least one workflow.");
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
        `${choiceIndex === index ? "›" : " "} [${selected.has(choice.value) ? "x" : " "}] ${choice.label}`
      )),
      error ? h(Text, { color: colorEnabled ? "red" : undefined }, error) : null
    )
  );
}

function TextInputScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const pendingPemMarkerRef = useRef("");
  const pemInputBlockedRef = useRef(false);
  const cancel = useCancel(onCancel);
  const append = useCallback((text) => {
    if (pemInputBlockedRef.current) return false;
    const safe = sanitizeTextInput(text);
    if (!safe) return true;
    const combined = `${pendingPemMarkerRef.current}${safe}`;
    pendingPemMarkerRef.current = "";
    const upper = combined.toUpperCase();
    if (containsPrivateKeyPemEnvelope(combined) || PEM_MARKER_STARTS.some((marker) => upper.includes(marker))) {
      pemInputBlockedRef.current = true;
      setError(PRIVATE_KEY_INPUT_ERROR);
      return false;
    }
    const pendingLength = pendingPemMarkerLength(combined);
    const visible = pendingLength ? combined.slice(0, -pendingLength) : combined;
    pendingPemMarkerRef.current = pendingLength ? combined.slice(-pendingLength) : "";
    if (visible) setValue((current) => `${current}${visible}`.slice(0, spec.maxLength ?? 256));
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
      const typedValue = `${value}${pendingPemMarkerRef.current}`;
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
      else setValue((current) => current.slice(0, -1));
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
  const [received, setReceived] = useState(false);
  const [error, setError] = useState("");
  const cancel = useCancel(onCancel);
  const accept = useCallback((text) => {
    if (received) {
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
  }, [received, spec]);
  usePaste(accept);
  useInput((input, key) => {
    cancel(input, key);
    if (key.return) {
      if (received) onSubmit(true);
      else setError("Paste the credential before continuing.");
      return;
    }
    if (!key.ctrl && !key.meta && input) accept(input);
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
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
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
      const choice = choices[index];
      if (!choice) return;
      spec.picker.activate(choice.id).then((result) => {
        if (result.selected) onSubmit(result.value);
      }).catch(() => {
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
        "Only .pem key files are shown. The newest files are first.",
        "Folders, other files, and links are hidden. The picker does not open the key or display its path."
      ],
      footer: "↑/↓ move  •  Enter select  •  Esc cancel",
      colorEnabled
    },
    h(Text, { bold: true }, `Keys in ${listing?.folderLabel ?? "Loading…"}`),
    error ? h(Text, { color: colorEnabled ? "red" : undefined }, error) : null,
    !error && !listing ? h(Text, { dimColor: true }, "Finding key files...") : null,
    listing && !choices.length ? h(Text, { dimColor: true }, `No usable .pem keys found in ${listing.folderLabel}. Download a new GitHub App key, then retry.`) : null,
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

function reviewData(plan) {
  const policyFile = plan.files.find((file) => file.path === ".github/codekeeper.json");
  const policy = JSON.parse(policyFile.contents);
  const documents = documentMap(plan.files);
  return {
    repository: `${plan.repository} · ${plan.defaultBranch}`,
    identity: `${plan.displayName} · owners: ${plan.ownerLogins.join(", ")}`,
    preset: `${plan.preset} starting models`,
    workflows: workflowMap(plan.modes).map((item) => `${item.label} — ${item.trigger}`),
    models: plan.modes.map((mode) => {
      const agent = policy.ai.agents[MODES[mode].policyAgent];
      return `${MODES[mode].agentLabel} (${MODES[mode].label}): ${agent.provider} / ${agent.model} / ${agent.effort}`;
    }),
    documents: documents.map((item) => `${item.path} — ${item.purpose}`),
    setupDocumentPaths: documents.filter((item) => !item.path.includes("/agents/")).map((item) => item.path),
    profileDocumentPaths: documents.filter((item) => item.path.includes("/agents/")).map((item) => item.path),
    secrets: plan.secrets.map((secret) => `${secret.name} — ${SECRET_PURPOSES[secret.name]}`),
    startup: plan.enabled ? "Codekeeper starts after merge." : "Codekeeper stays off after merge.",
    capabilities: capabilitySummary(plan.capabilities, plan.modes),
    reviewGateWarning: completionGuidance(plan.modes, plan.enabled).reviewGateWarning
  };
}

function ReviewScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [confirmed, setConfirmed] = useState(false);
  const [page, setPage] = useState(0);
  const cancel = useCancel(onCancel);
  const { stdout } = useStdout();
  const pagedDetail = usesPagedDetailLayout(stdout);
  const compactDetail = pagedDetail && Number.isFinite(stdout?.rows) && stdout.rows < 30;
  const lastPage = pagedDetail ? 7 : 2;
  const data = useMemo(() => reviewData(spec.plan), [spec.plan]);
  usePaste(() => {});
  useInput((input, key) => {
    cancel(input, key);
    if (page < lastPage) {
      if (key.leftArrow || input === "h") setPage((value) => Math.max(0, value - 1));
      if (key.rightArrow || input === "l" || key.tab) setPage((value) => Math.min(lastPage, value + 1));
      if (key.return) setPage((value) => Math.min(lastPage, value + 1));
      return;
    }
    if (key.leftArrow || key.upArrow || input === "h" || input === "k") setConfirmed(true);
    if (key.rightArrow || key.downArrow || input === "l" || input === "j" || key.tab) setConfirmed(false);
    if (key.backspace) setPage(Math.max(0, lastPage - 1));
    if (key.return) onSubmit(confirmed);
  });
  const section = (title, lines, marginTop = 1) => h(
    Box,
    { key: title, flexDirection: "column", marginTop },
    h(Text, { bold: true }, title),
    ...lines.map((line, index) => h(Text, { key: `${title}-${index}`, dimColor: true }, `  ${line}`))
  );
  return h(
    Shell,
    {
      step: "final review",
      title: `Review the setup · ${page + 1} of ${lastPage + 1}`,
      description: pagedDetail
        ? [page === 0 ? "The App key is selected. Its path and contents stay hidden." : "Nothing has changed yet."]
        : [
          "The App key file is selected. Its path and contents are not shown.",
          "Nothing has changed. Select Create setup to apply these choices."
        ],
      footer: page < lastPage
        ? "←/→ page  •  Enter next  •  Esc cancel"
        : "←/→ choose  •  Backspace previous  •  Enter confirm  •  Esc cancel",
      colorEnabled,
      compactDetail
    },
    !pagedDetail && page === 0 ? h(
      Box,
      { flexDirection: "column" },
      h(Text, null, data.repository),
      h(Text, { dimColor: true }, data.identity),
      h(Text, { dimColor: true }, data.preset),
      section("Workflows", data.workflows),
      section("Models (editable in .github/codekeeper.json)", data.models)
    ) : null,
    !pagedDetail && page === 1 ? h(
      Box,
      { flexDirection: "column" },
      section("Document map", data.documents),
      section("Secrets requested through GitHub CLI", data.secrets)
    ) : null,
    !pagedDetail && page === 2 ? h(
      Box,
      { flexDirection: "column" },
      section("Settings", [data.startup, ...data.capabilities, ...CONSERVATIVE_BOUNDARIES]),
      data.reviewGateWarning ? h(Text, { dimColor: true }, data.reviewGateWarning) : null,
      h(
        Box,
        { flexDirection: "column", marginTop: 1 },
        h(Text, { bold: confirmed, inverse: confirmed }, `${confirmed ? "›" : " "} Create setup`),
        h(Text, { bold: !confirmed, inverse: !confirmed }, `${!confirmed ? "›" : " "} Cancel`)
      )
    ) : null,
    pagedDetail && page === 0 ? h(
      Box,
      { flexDirection: "column" },
      h(Text, null, data.repository),
      h(Text, { dimColor: true }, data.identity),
      h(Text, { dimColor: true }, data.preset),
      section("Workflows", data.workflows, 0)
    ) : null,
    pagedDetail && page === 1 ? section("Models (editable in .github/codekeeper.json)", data.models, 0) : null,
    pagedDetail && page === 2 ? section("Policy and caller documents", data.setupDocumentPaths, 0) : null,
    pagedDetail && page === 3 ? section("Editable agent profiles", data.profileDocumentPaths, 0) : null,
    pagedDetail && page === 4 ? section("Secrets requested through GitHub CLI", data.secrets, 0) : null,
    pagedDetail && page === 5 ? section("Settings", [data.startup, ...data.capabilities], 0) : null,
    pagedDetail && page === 6 ? section("Fixed boundaries", CONSERVATIVE_BOUNDARIES, 0) : null,
    pagedDetail && page === 7 ? h(
      Box,
      { flexDirection: "column" },
      data.reviewGateWarning ? h(Text, { dimColor: true }, data.reviewGateWarning) : null,
      h(
        Box,
        { flexDirection: "column", marginTop: 1 },
        h(Text, { bold: confirmed, inverse: confirmed }, `${confirmed ? "›" : " "} Create setup`),
        h(Text, { bold: !confirmed, inverse: !confirmed }, `${!confirmed ? "›" : " "} Cancel`)
      )
    ) : null
  );
}

function ProgressScreen({ state, colorEnabled }) {
  const statuses = new Map(state.events.map((event) => [event.id, event]));
  return h(
    Shell,
    {
      step: "installing",
      title: "Creating the Codekeeper setup",
      description: ["Keep this terminal open until the setup pull request is ready."],
      footer: state.paused ? "GitHub CLI has the terminal. Complete its secret prompt to return." : "Please keep this terminal open.",
      colorEnabled
    },
    h(
      Box,
      { flexDirection: "column" },
      ...state.steps.map((step) => {
        const event = statuses.get(step.id) ?? { status: "pending" };
        const symbol = event.status === "done" ? "✓" : event.status === "active" ? "›" : event.status === "failed" ? "!" : "·";
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
  const guidance = completionGuidance(spec.plan.modes, spec.plan.enabled);
  const completedSteps = spec.receipt.settingsOnly
    ? DEFAULT_PROGRESS_STEPS.filter((step) => ["repository:verify", "settings:disable", "variables:configure"].includes(step.id))
    : DEFAULT_PROGRESS_STEPS;
  return h(
    Shell,
    {
      step: "complete",
      title: "Setup complete",
      description: [spec.receipt.pullRequestUrl],
      footer: "Enter finish  •  Esc close",
      colorEnabled
    },
    h(
      Box,
      { flexDirection: "column" },
      ...completedSteps.map((step) => h(Text, { key: step.id, dimColor: true }, `✓ ${step.label}`)),
      compact ? null : h(Text, { dimColor: true }, `Source: ${spec.plan.source.repository}@${spec.plan.source.commit}`),
      h(Text, { dimColor: true }, spec.plan.enabled ? "Codekeeper starts after merge." : "Codekeeper stays off after merge."),
      compact ? null : h(Text, { dimColor: true }, `OpenAI traces: ${spec.plan.tracing ? "enabled" : "disabled"}.`),
      !compact && guidance.reviewGateWarning ? h(Text, { dimColor: true }, guidance.reviewGateWarning) : null,
      h(Text, { dimColor: true }, compact ? "Review the setup pull request." : guidance.closing)
    )
  );
}

function IdleScreen({ colorEnabled }) {
  return h(
    Shell,
    {
      step: "preparing",
      title: "Codekeeper guided setup",
      description: ["Checking the installer and repository before anything can change."],
      footer: "Please wait…",
      colorEnabled
    },
    h(Text, { dimColor: true }, "No repository mutation occurs during setup questions.")
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
    pendingRef.current = { resolve, reject };
    screenIdRef.current += 1;
    setScreen({ ...spec, screenId: screenIdRef.current });
  }), []);
  const settle = useCallback((value, error) => {
    const pending = pendingRef.current;
    if (!pending) return;
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
    onSubmit: (value) => settle(value),
    onCancel: screen.kind === "completion" ? () => settle(true) : (error) => settle(null, error),
    colorEnabled
  };
  if (screen.kind === "confirm") return h(ConfirmScreen, common);
  if (screen.kind === "select") return h(SelectScreen, common);
  if (screen.kind === "multiselect") return h(MultiSelectScreen, common);
  if (screen.kind === "input") return h(TextInputScreen, common);
  if (screen.kind === "secret") return h(SecretInputScreen, common);
  if (screen.kind === "file") return h(FilePickerScreen, common);
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
      alternateScreen: false,
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
export {
  createPrivateKeyPickerController,
  defaultPrivateKeyDirectory,
  listPrivateKeyChoices
} from "./private-key-input.mjs";
