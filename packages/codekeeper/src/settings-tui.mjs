import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { InstallerError } from "./errors.mjs";
import {
  containsPrivateKeyPemEnvelope,
  inspectPrivateKeyTextInput,
  PRIVATE_KEY_INPUT_ERROR
} from "./input-safety.mjs";
import { parseSettingValue, resetProfileOverride, setSetting, settingsRows, validateEditableSettings } from "./settings.mjs";

const h = React.createElement;

function cancelled() {
  return new InstallerError("Interactive setup was cancelled.", { code: "PROMPT_ABORTED" });
}

function valueText(row) {
  if (row.kind === "profile") return row.source === "repository" ? "custom" : "Codekeeper default";
  if (row.kind === "boolean") return row.value ? "on" : "off";
  if (row.kind === "json") return JSON.stringify(row.value);
  return String(row.value ?? "");
}

function controlText(row) {
  if (row.kind === "boolean") return "Press Space or Enter to turn this setting on or off.";
  if (row.kind === "enum") return "Press Enter to see every choice. You can also use Left and Right.";
  if (row.kind === "profile") return "Press Enter to edit these instructions here. Press R to restore the Codekeeper default.";
  if (["string", "number", "json"].includes(row.kind)) return "Press Enter to type a new value.";
  if (row.kind === "submit") return "Press Enter to review every change before Codekeeper applies it.";
  return "";
}

function sectionIcon(section) {
  return ({ workflows: "⚡", automation: "⏱", review: "🔎", audit: "🛠", issues: "📌", merge: "🔀", ai: "🤖", profiles: "📝", labels: "🏷", repository: "📦" })[section] ?? "•";
}

export function settingInputText(row) {
  return row.kind === "json" ? JSON.stringify(row.value, null, 2) : String(row.value ?? "");
}

function color(enabled, name) {
  return enabled ? { color: name } : {};
}

function fitLine(value, width) {
  const text = String(value).replace(/\s*\n\s*/g, " ↵ ");
  if ([...text].length <= width) return text;
  return `${[...text].slice(0, Math.max(1, width - 1)).join("")}…`;
}

function parseEditorCommand(command) {
  const argv = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && ['"', "\\"].includes(command[index + 1])) {
        token += command[index + 1];
        index += 1;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) argv.push(token);
      token = "";
      tokenStarted = false;
      continue;
    }
    if (["'", '"'].includes(character)) {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && command[index + 1] && /[\s'"\\]/.test(command[index + 1])) {
      token += command[index + 1];
      tokenStarted = true;
      index += 1;
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (quote) throw new InstallerError("$EDITOR or $VISUAL contains an unterminated quote.", { code: "EDITOR_INVALID" });
  if (tokenStarted) argv.push(token);
  if (!argv[0]) throw new InstallerError("Set $EDITOR or $VISUAL to a valid editor command.", { code: "EDITOR_INVALID" });
  return argv;
}

export function SettingsScreen({ spec, onSubmit, onCancel, colorEnabled }) {
  const [settings, setSettings] = useState(spec.settings);
  const [advanced, setAdvanced] = useState(false);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [choosing, setChoosing] = useState(null);
  const [pendingWarning, setPendingWarning] = useState(null);
  const [warningConfirmed, setWarningConfirmed] = useState(false);
  const pendingPemMarkerRef = useRef("");
  const pemInputBlockedRef = useRef(false);
  const { stdout } = useStdout();
  const compact = Number.isFinite(stdout?.columns) && stdout.columns < 60;
  const lineWidth = Math.max(16, (stdout?.columns ?? 80) - (compact ? 1 : 8));
  const rows = useMemo(() => [
    ...settingsRows(settings, { advanced }),
    {
      id: "apply",
      section: "review",
      label: "Review and create the setup pull request",
      description: "Check the workflows, models, files, credentials, and safety limits on five short pages.",
      kind: "submit",
      value: "continue"
    }
  ], [advanced, settings]);
  const visibleCount = compact ? 5 : Math.max(5, Math.min(16, (stdout?.rows ?? 24) - 14));
  const start = Math.max(0, Math.min(index - Math.floor(visibleCount / 2), rows.length - visibleCount));
  const visible = rows.slice(start, start + visibleCount);
  const selectedRow = rows[index] ?? rows[0];
  const changedCount = useMemo(() => {
    const initial = new Map(settingsRows(spec.settings, { advanced: true }).map((row) => [row.id, JSON.stringify(row.value)]));
    return settingsRows(settings, { advanced: true })
      .filter((row) => initial.get(row.id) !== JSON.stringify(row.value)).length;
  }, [settings, spec.settings]);

  const applyValue = (row, value) => {
    try {
      setSettings((current) => setSetting(current, row, value));
      setError("");
      setNotice(`Updated ${row.label}.`);
      return true;
    } catch (cause) {
      setNotice("");
      setError(cause.message);
      return false;
    }
  };

  const requestValue = (row, value) => {
    if (JSON.stringify(row.value) === JSON.stringify(value)) return true;
    if (row.warning) {
      setPendingWarning({ row, value });
      setWarningConfirmed(false);
      setNotice("");
      setError("");
      return false;
    }
    return applyValue(row, value);
  };

  const resetPemInput = () => {
    pendingPemMarkerRef.current = "";
    pemInputBlockedRef.current = false;
  };
  const appendEditingText = (text) => {
    if (pemInputBlockedRef.current) return;
    const inspected = inspectPrivateKeyTextInput(pendingPemMarkerRef.current, text);
    pendingPemMarkerRef.current = inspected.pending;
    if (inspected.blocked) {
      pemInputBlockedRef.current = true;
      setError(PRIVATE_KEY_INPUT_ERROR);
      return;
    }
    const visible = editing?.row.kind === "profile" && !inspected.pending
      ? String(text).replace(/\r\n?/g, "\n")
      : inspected.visible;
    if (visible) setEditing((current) => ({ ...current, text: `${current.text}${visible}`.slice(0, 64 * 1024) }));
  };

  usePaste((text) => {
    if (editing) appendEditingText(text);
  });
  useInput((input, key) => {
    if (pendingWarning) {
      if (key.escape || input.toLowerCase() === "n") {
        setPendingWarning(null);
        setWarningConfirmed(false);
        return;
      }
      if (input.toLowerCase() === "y" || key.leftArrow || key.upArrow) setWarningConfirmed(true);
      if (key.rightArrow || key.downArrow || key.tab) setWarningConfirmed(false);
      if (key.return) {
        if (warningConfirmed) applyValue(pendingWarning.row, pendingWarning.value);
        setPendingWarning(null);
        setWarningConfirmed(false);
      }
      return;
    }
    if (choosing) {
      if (key.escape) {
        setChoosing(null);
        return;
      }
      if (key.upArrow || input === "k") setChoosing((current) => ({ ...current, index: (current.index - 1 + current.row.choices.length) % current.row.choices.length }));
      if (key.downArrow || input === "j" || key.tab) setChoosing((current) => ({ ...current, index: (current.index + 1) % current.row.choices.length }));
      if (key.return) {
        const value = choosing.row.choices[choosing.index];
        setChoosing(null);
        requestValue(choosing.row, value);
      }
      return;
    }
    if (editing) {
      if (key.ctrl && input.toLowerCase() === "c") return onCancel(cancelled());
      if (key.escape) {
        setEditing(null);
        resetPemInput();
        setError("");
        return;
      }
      if (key.return) {
        if (pemInputBlockedRef.current) {
          setError(PRIVATE_KEY_INPUT_ERROR);
          return;
        }
        try {
          const value = parseSettingValue(editing.row, `${editing.text}${pendingPemMarkerRef.current}`);
          requestValue(editing.row, value);
          setEditing(null);
        } catch (cause) {
          setError(cause.message);
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (pendingPemMarkerRef.current) pendingPemMarkerRef.current = pendingPemMarkerRef.current.slice(0, -1);
        else setEditing((current) => ({ ...current, text: current.text.slice(0, -1) }));
        return;
      }
      if (key.ctrl && input.toLowerCase() === "u") {
        resetPemInput();
        setEditing((current) => ({ ...current, text: "" }));
        setError("");
        return;
      }
      if (!key.ctrl && !key.meta && input) appendEditingText(input);
      return;
    }
    if (key.escape || (key.ctrl && input.toLowerCase() === "c")) return onCancel(cancelled());
    if (input.toLowerCase() === "a") {
      setAdvanced((value) => !value);
      setIndex(0);
      setError("");
      return;
    }
    if (input === "G" || key.end) {
      setIndex(rows.length - 1);
      return;
    }
    if (input === "g" || key.home) {
      setIndex(0);
      return;
    }
    if (key.upArrow || input === "k") setIndex((value) => (value - 1 + rows.length) % rows.length);
    if (key.downArrow || input === "j" || key.tab) setIndex((value) => (value + 1) % rows.length);
    const row = rows[index];
    if (!row) return;
    if (input.toLowerCase() === "r" && row.kind === "profile") {
      setSettings((current) => resetProfileOverride(current, row.profile));
      setError("");
      setNotice(row.source === "repository"
        ? "Using the packaged default; the repository override will be removed after final review."
        : "This profile already uses the packaged default.");
      return;
    }
    if (input === " " && row.kind === "boolean") requestValue(row, !row.value);
    if ((key.leftArrow || key.rightArrow) && row.kind === "enum") {
      const direction = key.leftArrow ? -1 : 1;
      const current = row.choices.indexOf(row.value);
      requestValue(row, row.choices[(current + direction + row.choices.length) % row.choices.length]);
    }
    if (!key.return) return;
    if (row.kind === "submit") {
      try {
        validateEditableSettings(settings, spec.baselinePolicy);
        onSubmit(settings);
      } catch (cause) {
        setError(cause.message);
      }
    } else if (row.kind === "boolean") {
      requestValue(row, !row.value);
    } else if (row.kind === "enum") {
      setChoosing({ row, index: Math.max(0, row.choices.indexOf(row.value)) });
      setError("");
    } else if (["profile", "string", "number", "json"].includes(row.kind)) {
      resetPemInput();
      setEditing({ row, text: settingInputText(row) });
      setError("");
    }
  });

  if (pendingWarning) return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: colorEnabled ? "yellow" : undefined, paddingX: 2, paddingY: 1, width: "100%" },
    h(Text, { bold: true, ...color(colorEnabled, "yellow") }, "⚠  CHECK THIS CHANGE"),
    h(Text, { bold: true }, pendingWarning.row.label),
    h(Text, null, pendingWarning.row.warning),
    h(Text, { dimColor: true }, `New value: ${valueText({ ...pendingWarning.row, value: pendingWarning.value })}`),
    h(Box, { flexDirection: "column", marginTop: 1 },
      h(Text, { bold: warningConfirmed, inverse: warningConfirmed }, `${warningConfirmed ? "›" : " "} Apply this change`),
      h(Text, { bold: !warningConfirmed, inverse: !warningConfirmed }, `${!warningConfirmed ? "›" : " "} Keep the current value`)
    ),
    h(Text, { dimColor: true }, "←/→ choose  •  Enter confirm  •  Esc keep current value")
  );

  if (choosing) return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: colorEnabled ? "cyan" : undefined, paddingX: 2, paddingY: 1, width: "100%" },
    h(Text, { bold: true, ...color(colorEnabled, "cyan") }, "CODEKEEPER  ·  CHOOSE A VALUE"),
    h(Text, { bold: true }, choosing.row.label),
    h(Text, { dimColor: true }, choosing.row.description),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...choosing.row.choices.map((choice, choiceIndex) => h(Text, {
        key: choice,
        bold: choiceIndex === choosing.index,
        inverse: choiceIndex === choosing.index,
        ...color(colorEnabled && choiceIndex === choosing.index, "cyan")
      }, `${choiceIndex === choosing.index ? "›" : " "} ${choice}`))
    ),
    h(Text, { dimColor: true }, "↑/↓ move  •  Enter select  •  Esc back")
  );

  if (editing) return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: colorEnabled ? "cyan" : undefined, paddingX: 2, paddingY: 1, width: "100%" },
    h(Text, { bold: true, ...color(colorEnabled, "cyan") }, "✦ CODEKEEPER  ·  EDIT SETTING"),
    h(Text, { bold: true }, editing.row.label),
    h(Text, { dimColor: true }, fitLine(editing.row.description, lineWidth)),
    h(Box, { borderStyle: "single", paddingX: 1, marginTop: 1 }, h(Text, null, fitLine(editing.text, Math.max(8, lineWidth - 4))), h(Text, color(colorEnabled, "cyan"), "▌")),
    error ? h(Text, color(colorEnabled, "red"), error) : null,
    h(Text, { dimColor: true }, fitLine(editing.row.kind === "profile"
      ? "Paste multi-line text  •  Enter save  •  Ctrl-U clear  •  Esc back"
      : "Enter save  •  Ctrl-U clear  •  Esc back", lineWidth))
  );

  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: compact ? undefined : "round",
      borderColor: colorEnabled ? "cyan" : undefined,
      paddingX: compact ? 0 : 2,
      paddingY: compact ? 0 : 1,
      width: "100%"
    },
    h(Box, compact ? { flexDirection: "column" } : { justifyContent: "space-between" },
      h(Text, { bold: true, ...color(colorEnabled, "cyan") }, compact ? "✦ CODEKEEPER SETTINGS" : "✦ CODEKEEPER"),
      h(Text, { bold: true }, advanced ? "[ STANDARD ]  [● ADVANCED ]" : "[● STANDARD ]  [ ADVANCED ]")
    ),
    h(Text, { bold: true }, "Choose how Codekeeper works"),
    h(Text, { dimColor: true }, fitLine(`${spec.repository}  •  ${rows.length - 1} editable settings  •  ${changedCount} changed`, lineWidth)),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...visible.map((row, offset) => {
        const selected = start + offset === index;
        const rendered = valueText(row);
        return h(Text, {
          key: row.id,
          bold: selected,
          inverse: selected,
          ...color(colorEnabled && selected, "cyan")
        }, fitLine(`${selected ? "›" : " "} ${sectionIcon(row.section)} ${row.label}: ${rendered}`, lineWidth));
      })
    ),
    h(Text, { dimColor: true }, `${start + 1}–${Math.min(rows.length, start + visibleCount)} of ${rows.length}`),
    h(Box, { flexDirection: "column", borderStyle: compact ? undefined : "single", borderColor: colorEnabled ? "gray" : undefined, paddingX: compact ? 0 : 1, marginTop: 1 },
      compact ? null : h(Text, { bold: true }, selectedRow.label),
      h(Text, { dimColor: true }, fitLine(selectedRow.description, Math.max(8, lineWidth - 4))),
      h(Text, color(colorEnabled, selectedRow.warning ? "yellow" : "cyan"), fitLine(`${selectedRow.warning ? "⚠ " : ""}${controlText(selectedRow)}`, Math.max(8, lineWidth - 4)))
    ),
    notice ? h(Text, color(colorEnabled, "cyan"), notice) : null,
    error ? h(Text, color(colorEnabled, "red"), error) : null,
    h(Text, { dimColor: true }, fitLine("↑/↓ move  •  Enter use  •  A switch view  •  G end  •  Esc cancel", lineWidth))
  );
}

export async function editProfileWithEditor({ profile, source, environment = process.env, suspendTerminal = (callback) => callback(), runEditor = null, spawnEditor = spawn }) {
  const editor = String(environment.EDITOR ?? environment.VISUAL ?? "").trim();
  if (!editor) throw new InstallerError("Set $EDITOR or $VISUAL before editing an agent profile.", { code: "EDITOR_UNAVAILABLE" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-profile-"));
  const file = path.join(directory, `${profile}.md`);
  try {
    await writeFile(file, source, { mode: 0o600 });
    const status = await suspendTerminal(() => runEditor
      ? runEditor(editor, file)
      : new Promise((resolve, reject) => {
        const [executable, ...arguments_] = parseEditorCommand(editor);
        const child = spawnEditor(executable, [...arguments_, file], { stdio: "inherit", shell: false });
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
      }));
    if (status !== 0) throw new InstallerError("The profile editor exited without saving successfully.", { code: "EDITOR_FAILED" });
    const edited = await readFile(file, "utf8");
    if (!edited.trim() || Buffer.byteLength(edited) > 64 * 1024 || edited.includes("\0") || containsPrivateKeyPemEnvelope(edited)) throw new InstallerError("The edited agent profile is empty or invalid.", { code: "PROFILE_INVALID" });
    return edited;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
