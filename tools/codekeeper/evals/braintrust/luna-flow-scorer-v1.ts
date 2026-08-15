function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  for (const key of ["content", "output", "choices", "message"]) {
    const text = extractText(value[key]);
    if (text) return text;
  }
  return "";
}

function parseOutput(output) {
  if (output && typeof output === "object" && !Array.isArray(output) && output.caseId) {
    return output;
  }
  const raw = extractText(output).trim();
  const text = raw.startsWith(String.fromCharCode(96, 96, 96))
    ? raw.replace(/^.{3}json\s*/i, "").replace(/.{3}$/, "")
    : raw;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sameSortedStrings(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function handler({ output, expected }) {
  const result = parseOutput(output);
  if (!result || !expected || typeof expected !== "object") {
    return {
      name: "Codekeeper Luna flow contract",
      score: 0,
      metadata: { failed: ["valid JSON output and expected record"] },
    };
  }

  const checks = [
    ["case identity", result.caseId === expected.caseId],
    ["flow decision", result.decision === expected.decision],
    ["exact finding set", sameSortedStrings(result.findingKeys, expected.findingKeys)],
    ["exact blocking set", sameSortedStrings(result.blockingKeys, expected.blockingKeys)],
    ["duplicate decision", result.duplicateOf === expected.duplicateOf],
    ["patch decision", result.patchOption === expected.patchOption],
  ];
  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return {
    name: "Codekeeper Luna flow contract",
    score: (checks.length - failed.length) / checks.length,
    metadata: {
      caseId: expected.caseId,
      passed: checks.length - failed.length,
      total: checks.length,
      failed,
    },
  };
}
