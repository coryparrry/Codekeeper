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
import { parseSettingValue, setSetting, settingsRows, validateEditableSettings } from "./settings.mjs";

const h = React.createElement;

function cancelled() {
  return new InstallerError("Interactive setup was cancelled.", { code: "PROMPT_ABORTED" });
}

function valueText(row) {
  if (row.kind === "profile") return "edit in $EDITOR";
  if (row.kind === "boolean") return row.value ? "on" : "off";
  if (row.kind === "json") return JSON.stringify(row.value);
  return String(row.value ?? "");
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
  const [busy, setBusy] = useState(false);
  const pendingPemMarkerRef = useRef("");
  const pemInputBlockedRef = useRef(false);
  const { stdout } = useStdout();
  const lineWidth = Math.max(16, (stdout?.columns ?? 80) - 2);
  const rows = useMemo(() => [
    ...settingsRows(settings, { advanced }),
    { id: "apply", section: "review", label: "Continue to final review", kind: "submit", value: "review changes" }
  ], [advanced, settings]);
  const visibleCount = Math.max(6, Math.min(18, (stdout?.rows ?? 24) - 9));
  const start = Math.max(0, Math.min(index - Math.floor(visibleCount / 2), rows.length - visibleCount));
  const visible = rows.slice(start, start + visibleCount);

  const applyValue = (row, value) => {
    try {
      setSettings((current) => setSetting(current, row, value));
      setError("");
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
    }
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
    if (inspected.visible) setEditing((current) => ({ ...current, text: `${current.text}${inspected.visible}`.slice(0, 64 * 1024) }));
  };

  usePaste((text) => {
    if (editing) appendEditingText(text);
  });
  useInput((input, key) => {
    if (busy) return;
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
          if (applyValue(editing.row, value)) setEditing(null);
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
    if (input === " " && row.kind === "boolean") applyValue(row, !row.value);
    if ((key.leftArrow || key.rightArrow) && row.kind === "enum") {
      const direction = key.leftArrow ? -1 : 1;
      const current = row.choices.indexOf(row.value);
      applyValue(row, row.choices[(current + direction + row.choices.length) % row.choices.length]);
    }
    if (!key.return) return;
    if (row.kind === "submit") {
      try {
        validateEditableSettings(settings, spec.baselinePolicy);
        onSubmit(settings);
      } catch (cause) {
        setError(cause.message);
      }
    } else if (row.kind === "profile") {
      setBusy(true);
      spec.editProfile(row.profile, row.value)
        .then((source) => applyValue(row, source))
        .catch((cause) => setError(cause.message))
        .finally(() => setBusy(false));
    } else if (["string", "number", "json"].includes(row.kind)) {
      resetPemInput();
      setEditing({ row, text: settingInputText(row) });
      setError("");
    } else if (row.kind === "readonly") {
      setError("This safety or release setting is read-only.");
    }
  });

  if (editing) return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(Text, { bold: true, ...color(colorEnabled, "cyan") }, "CODEKEEPER  SETTINGS"),
    h(Text, { bold: true }, editing.row.label),
    h(Text, { dimColor: true }, fitLine(editing.row.kind === "json" ? "Edit valid JSON, then press Enter." : "Edit the value, then press Enter.", lineWidth)),
    h(Box, { borderStyle: "single", paddingX: 1, marginTop: 1 }, h(Text, null, fitLine(editing.text, Math.max(8, lineWidth - 4))), h(Text, color(colorEnabled, "cyan"), "▌")),
    error ? h(Text, color(colorEnabled, "red"), error) : null,
    h(Text, { dimColor: true }, fitLine("Enter save  •  Ctrl-U clear  •  Esc back  •  Ctrl-C cancel", lineWidth))
  );

  return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(Box, { justifyContent: "space-between" },
      h(Text, { bold: true, ...color(colorEnabled, "cyan") }, "CODEKEEPER  SETTINGS"),
      h(Text, { bold: true }, advanced ? "ADVANCED" : "STANDARD")
    ),
    h(Text, { dimColor: true }, fitLine(`${spec.repository} · ${rows.length - 1} settings · no changes applied yet`, lineWidth)),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...visible.map((row, offset) => {
        const selected = start + offset === index;
        const rendered = valueText(row);
        return h(Text, {
          key: row.id,
          bold: selected,
          inverse: selected,
          ...color(colorEnabled && selected, "cyan")
        }, fitLine(`${selected ? "›" : " "} ${row.section.padEnd(11).slice(0, 11)} ${row.label}: ${rendered}`, lineWidth));
      })
    ),
    h(Text, { dimColor: true }, `${start + 1}–${Math.min(rows.length, start + visibleCount)} of ${rows.length}`),
    busy ? h(Text, color(colorEnabled, "cyan"), "Waiting for $EDITOR…") : null,
    error ? h(Text, color(colorEnabled, "red"), error) : null,
    h(Text, { dimColor: true }, fitLine("↑/↓ move  •  Space toggle  •  ←/→ cycle  •  Enter edit  •  A Standard/Advanced  •  Esc cancel", lineWidth))
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
