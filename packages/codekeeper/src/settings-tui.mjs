import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { InstallerError } from "./errors.mjs";
import {
  containsPrivateKeyPemEnvelope,
  inspectPrivateKeyTextInput,
  PRIVATE_KEY_INPUT_ERROR
} from "./input-safety.mjs";
import { parseSettingValue, resetProfileOverride, SETTINGS_SECTIONS, setSetting, settingsRows, validateEditableSettings } from "./settings.mjs";

const h = React.createElement;
const CUSTOM_MODEL_CHOICE = "Type another model ID…";

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
  if (row.kind === "boolean") return "Use Left or Right, or press Space, to turn this setting on or off.";
  if (row.kind === "enum") return "Use Left or Right to change this choice. Space also moves to the next choice.";
  if (row.kind === "model") return "Use Left or Right to change model. Press Enter to see all models or type another ID.";
  if (row.kind === "profile") return "Press Enter to edit these instructions here. Press R to restore the Codekeeper default.";
  if (["string", "number", "json"].includes(row.kind)) return "Press Enter to type a new value.";
  if (row.kind === "submit") return "Press Enter to open one short summary before Codekeeper changes anything.";
  return "";
}

export function settingInputText(row) {
  return row.kind === "json" ? JSON.stringify(row.value, null, 2) : String(row.value ?? "");
}

function color(enabled, name) {
  return enabled ? { color: name } : {};
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
  const [settings, setSettings, settingsRef] = useCurrentState(spec.settings);
  const [advanced, setAdvanced, advancedRef] = useCurrentState(false);
  const [sectionIndex, setSectionIndex, sectionIndexRef] = useCurrentState(0);
  const [index, setIndex, indexRef] = useCurrentState(0);
  const [editing, setEditing, editingRef] = useCurrentState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [choosing, setChoosing, choosingRef] = useCurrentState(null);
  const pendingPemMarkerRef = useRef("");
  const pemInputBlockedRef = useRef(false);
  const { stdout } = useStdout();
  const compact = Number.isFinite(stdout?.columns) && stdout.columns < 60;
  const lineWidth = Math.max(16, (stdout?.columns ?? 80) - (compact ? 1 : 8));
  const allRows = useMemo(() => settingsRows(settings, { advanced }), [advanced, settings]);
  const sections = [
    ...SETTINGS_SECTIONS.filter((section) => allRows.some((row) => row.section === section.id)),
    { id: "continue", label: "Continue", icon: "✓" }
  ];
  const activeSectionIndex = Math.min(sectionIndex, sections.length - 1);
  const activeSection = sections[activeSectionIndex];
  const rows = activeSection.id === "continue"
    ? [{
      id: "apply",
      section: "continue",
      label: "Review and create the setup pull request",
      description: "See one short summary, return here if needed, or create the pull request.",
      kind: "submit",
      value: "ready"
    }]
    : allRows.filter((row) => row.section === activeSection.id);
  const selectedIndex = Math.min(index, Math.max(0, rows.length - 1));
  const visibleCount = compact ? 4 : Math.max(5, Math.min(14, (stdout?.rows ?? 24) - 16));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), rows.length - visibleCount));
  const visible = rows.slice(start, start + visibleCount);
  const selectedRow = rows[selectedIndex] ?? rows[0];
  const groupWidth = activeSection.id === "ai" ? Math.min(24, Math.max(18, Math.floor(lineWidth * 0.27))) : 0;
  const labelWidth = Math.min(36, Math.max(12, ...rows.map((row) => row.label.length)));
  const changedCount = useMemo(() => {
    const initial = new Map(settingsRows(spec.settings, { advanced: true }).map((row) => [row.id, JSON.stringify(row.value)]));
    return settingsRows(settings, { advanced: true })
      .filter((row) => initial.get(row.id) !== JSON.stringify(row.value)).length;
  }, [settings, spec.settings]);

  const getNavigationSnapshot = () => {
    const currentAllRows = settingsRows(settingsRef.current, { advanced: advancedRef.current });
    const currentSections = [
      ...SETTINGS_SECTIONS.filter((section) => currentAllRows.some((row) => row.section === section.id)),
      { id: "continue", label: "Continue", icon: "✓" }
    ];
    const currentSectionIndex = Math.min(sectionIndexRef.current, currentSections.length - 1);
    const currentSection = currentSections[currentSectionIndex];
    const currentRows = currentSection.id === "continue"
      ? [{
        id: "apply",
        section: "continue",
        label: "Review and create the setup pull request",
        description: "See one short summary, return here if needed, or create the pull request.",
        kind: "submit",
        value: "ready"
      }]
      : currentAllRows.filter((row) => row.section === currentSection.id);
    const currentSelectedIndex = Math.min(indexRef.current, Math.max(0, currentRows.length - 1));
    return {
      allRows: currentAllRows,
      sections: currentSections,
      rows: currentRows,
      selectedIndex: currentSelectedIndex
    };
  };

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
    const currentRow = getNavigationSnapshot().allRows.find((candidate) => candidate.id === row.id) ?? row;
    if (JSON.stringify(currentRow.value) === JSON.stringify(value)) return true;
    return applyValue(currentRow, value);
  };

  const resetPemInput = () => {
    pendingPemMarkerRef.current = "";
    pemInputBlockedRef.current = false;
  };
  const appendEditingText = (text) => {
    if (pemInputBlockedRef.current) return;
    const currentEditing = editingRef.current;
    const inspected = inspectPrivateKeyTextInput(pendingPemMarkerRef.current, text);
    pendingPemMarkerRef.current = inspected.pending;
    if (inspected.blocked) {
      pemInputBlockedRef.current = true;
      setError(PRIVATE_KEY_INPUT_ERROR);
      return;
    }
    const visible = currentEditing?.row.kind === "profile" && !inspected.pending
      ? String(text).replace(/\r\n?/g, "\n")
      : inspected.visible;
    if (visible) setEditing((current) => ({ ...current, text: `${current.text}${visible}`.slice(0, 64 * 1024) }));
  };

  usePaste((text) => {
    if (editingRef.current) appendEditingText(text);
  });
  useInput((input, key) => {
    const inputWithoutReturn = input.replace(/[\r\n]/g, "");
    const returnPressed = key.return || input !== inputWithoutReturn;
    if (choosingRef.current) {
      if (key.escape) {
        setChoosing(null);
        return;
      }
      if (key.upArrow || key.leftArrow || inputWithoutReturn === "k" || inputWithoutReturn === "h") setChoosing((current) => ({ ...current, index: (current.index - 1 + current.choices.length) % current.choices.length }));
      if (key.downArrow || key.rightArrow || inputWithoutReturn === "j" || inputWithoutReturn === "l" || key.tab) setChoosing((current) => ({ ...current, index: (current.index + 1) % current.choices.length }));
      if (returnPressed) {
        const currentChoosing = choosingRef.current;
        const value = currentChoosing.choices[currentChoosing.index];
        setChoosing(null);
        if (currentChoosing.row.kind === "model" && value === CUSTOM_MODEL_CHOICE) {
          resetPemInput();
          setEditing({ row: currentChoosing.row, text: settingInputText(currentChoosing.row) });
          setError("");
        } else {
          requestValue(currentChoosing.row, value);
        }
      }
      return;
    }
    if (editingRef.current) {
      if (key.ctrl && inputWithoutReturn.toLowerCase() === "c") return onCancel(cancelled());
      if (key.escape) {
        setEditing(null);
        resetPemInput();
        setError("");
        return;
      }
      if (returnPressed) {
        if (inputWithoutReturn) appendEditingText(inputWithoutReturn);
        if (pemInputBlockedRef.current) {
          setError(PRIVATE_KEY_INPUT_ERROR);
          return;
        }
        try {
          const currentEditing = editingRef.current;
          const value = parseSettingValue(currentEditing.row, `${currentEditing.text}${pendingPemMarkerRef.current}`);
          requestValue(currentEditing.row, value);
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
      if (key.ctrl && inputWithoutReturn.toLowerCase() === "u") {
        resetPemInput();
        setEditing((current) => ({ ...current, text: "" }));
        setError("");
        return;
      }
      if (!key.ctrl && !key.meta && inputWithoutReturn) appendEditingText(inputWithoutReturn);
      return;
    }
    if (key.escape || (key.ctrl && inputWithoutReturn.toLowerCase() === "c")) return onCancel(cancelled());
    if (inputWithoutReturn.toLowerCase() === "a") {
      setAdvanced((value) => !value);
      setSectionIndex(0);
      setIndex(0);
      setError("");
      if (!returnPressed) return;
    }
    if (inputWithoutReturn === "G" || key.end) {
      const { sections: currentSections } = getNavigationSnapshot();
      setSectionIndex(currentSections.length - 1);
      setIndex(0);
      if (!returnPressed) return;
    }
    if (inputWithoutReturn === "g" || key.home) {
      setSectionIndex(0);
      setIndex(0);
      if (!returnPressed) return;
    }
    if (key.tab || inputWithoutReturn === "]" || inputWithoutReturn === "[") {
      const direction = inputWithoutReturn === "[" || (key.tab && key.shift) ? -1 : 1;
      const { sections: currentSections } = getNavigationSnapshot();
      setSectionIndex((value) => (value + direction + currentSections.length) % currentSections.length);
      setIndex(0);
      setError("");
      setNotice("");
      if (!returnPressed) return;
    }
    let currentNavigation = getNavigationSnapshot();
    if (key.upArrow || inputWithoutReturn === "k") setIndex((value) => (value - 1 + currentNavigation.rows.length) % currentNavigation.rows.length);
    if (key.downArrow || inputWithoutReturn === "j") setIndex((value) => (value + 1) % currentNavigation.rows.length);
    currentNavigation = getNavigationSnapshot();
    let row = currentNavigation.rows[currentNavigation.selectedIndex];
    if (!row) return;
    if (inputWithoutReturn.toLowerCase() === "r" && row.kind === "profile") {
      const currentRow = getNavigationSnapshot().allRows.find((candidate) => candidate.id === row.id) ?? row;
      setSettings((current) => resetProfileOverride(current, currentRow.profile));
      setError("");
      setNotice(currentRow.source === "repository"
        ? "Using the packaged default; the repository override will be removed after final review."
        : "This profile already uses the packaged default.");
      return;
    }
    if ((key.leftArrow || key.rightArrow || inputWithoutReturn === " ") && row.kind === "boolean") requestValue(row, !row.value);
    if ((key.leftArrow || key.rightArrow || inputWithoutReturn === " ") && ["enum", "model"].includes(row.kind)) {
      const direction = key.leftArrow ? -1 : 1;
      const current = row.choices.indexOf(row.value);
      requestValue(row, row.choices[(current + direction + row.choices.length) % row.choices.length]);
    }
    if (!returnPressed) return;
    currentNavigation = getNavigationSnapshot();
    row = currentNavigation.rows[currentNavigation.selectedIndex];
    if (row.kind === "submit") {
      try {
        const currentSettings = settingsRef.current;
        validateEditableSettings(currentSettings, spec.baselinePolicy);
        onSubmit(currentSettings);
      } catch (cause) {
        setError(cause.message);
      }
    } else if (["enum", "model"].includes(row.kind)) {
      const choices = row.kind === "model" ? [...row.choices, CUSTOM_MODEL_CHOICE] : row.choices;
      setChoosing({ row, choices, index: Math.max(0, choices.indexOf(row.value)) });
      setError("");
    } else if (["profile", "string", "number", "json"].includes(row.kind)) {
      resetPemInput();
      setEditing({ row, text: settingInputText(row) });
      setError("");
    }
  });

  if (choosing) return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: colorEnabled ? "cyan" : undefined, paddingX: 2, paddingY: 1, width: "100%" },
    h(Text, { bold: true, ...color(colorEnabled, "cyan") }, "CODEKEEPER  ·  CHOOSE A VALUE"),
    h(Text, { bold: true }, choosing.row.label),
    h(Text, { dimColor: true }, choosing.row.description),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...choosing.choices.map((choice, choiceIndex) => h(Text, {
        key: choice,
        bold: choiceIndex === choosing.index,
        inverse: choiceIndex === choosing.index,
        ...color(colorEnabled && choiceIndex === choosing.index, "cyan")
      }, `${choiceIndex === choosing.index ? "›" : " "} ${choice}`))
    ),
    h(Text, { dimColor: true }, "Arrow keys move  •  Enter select  •  Esc back")
  );

  if (editing) return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: colorEnabled ? "cyan" : undefined, paddingX: 2, paddingY: 1, width: "100%" },
    h(Text, { bold: true, ...color(colorEnabled, "cyan") }, "CODEKEEPER  ·  EDIT SETTING"),
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
      h(Text, { bold: true, ...color(colorEnabled, "cyan") }, compact ? "CODEKEEPER SETTINGS" : "CODEKEEPER"),
      h(Text, { bold: true }, advanced ? "[ SIMPLE ]  [● ADVANCED ]" : "[● SIMPLE ]  [ ADVANCED ]")
    ),
    h(Text, { bold: true }, "Choose how Codekeeper works"),
    h(Text, { dimColor: true }, fitLine(`${spec.repository}  •  ${allRows.length} editable settings  •  ${changedCount} changed`, lineWidth)),
    h(Box, { flexWrap: "wrap", marginTop: 1 },
      ...sections.map((section, candidateIndex) => h(Text, {
        key: section.id,
        bold: candidateIndex === activeSectionIndex,
        inverse: candidateIndex === activeSectionIndex,
        ...color(colorEnabled && candidateIndex === activeSectionIndex, "cyan")
      }, `${section.icon} ${section.label}  `))
    ),
    h(Text, { bold: true, ...color(colorEnabled, "cyan") }, `${activeSection.icon} ${activeSection.label}`),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...visible.map((row, offset) => {
        const selected = start + offset === selectedIndex;
        const rendered = valueText(row);
        const group = groupWidth ? fitLine(row.group ?? "", groupWidth - 1).padEnd(groupWidth) : "";
        const label = fitLine(row.label, labelWidth).padEnd(labelWidth);
        return h(Text, {
          key: row.id,
          bold: selected,
          inverse: selected,
          ...color(colorEnabled && selected, "cyan")
        }, fitLine(`${selected ? "›" : " "} ${group}${label}  ${rendered}`, lineWidth));
      })
    ),
    rows.length > visibleCount ? h(Text, { dimColor: true }, `${start + 1}–${Math.min(rows.length, start + visibleCount)} of ${rows.length}`) : null,
    h(Box, { flexDirection: "column", borderStyle: compact ? undefined : "single", borderColor: colorEnabled ? "gray" : undefined, paddingX: compact ? 0 : 1, marginTop: 1 },
      compact ? null : h(Text, { bold: true }, selectedRow.label),
      h(Text, { dimColor: true }, fitLine(selectedRow.description, Math.max(8, lineWidth - 4))),
      h(Text, color(colorEnabled, "cyan"), fitLine(controlText(selectedRow), Math.max(8, lineWidth - 4)))
    ),
    notice ? h(Text, color(colorEnabled, "cyan"), notice) : null,
    error ? h(Text, color(colorEnabled, "red"), error) : null,
    h(Text, { dimColor: true }, fitLine("Tab section  •  ↑/↓ setting  •  ←/→ choice  •  Space toggle  •  A simple/advanced  •  G/End continue  •  Esc", lineWidth))
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
