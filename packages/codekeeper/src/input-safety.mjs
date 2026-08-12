const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const PRIVATE_KEY_PEM_ENVELOPE =
  /-----(?:BEGIN|END) (?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY-----/i;
const PEM_MARKER_STARTS = Object.freeze(["-----BEGIN", "-----END"]);

export const PRIVATE_KEY_INPUT_ERROR =
  "Private keys cannot be pasted here. Press Ctrl-U, then select the downloaded .pem file at the private-key step.";

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
      if (upper.endsWith(marker.slice(0, length)))
        pendingLength = Math.max(pendingLength, length);
    }
  }
  return pendingLength;
}

export function inspectPrivateKeyTextInput(pending, text) {
  const safe = sanitizeTextInput(text);
  if (!safe) return { blocked: false, pending, visible: "" };
  const combined = `${pending}${safe}`;
  const upper = combined.toUpperCase();
  if (
    containsPrivateKeyPemEnvelope(combined) ||
    PEM_MARKER_STARTS.some((marker) => upper.includes(marker))
  ) {
    return { blocked: true, pending: "", visible: "" };
  }
  const pendingLength = pendingPemMarkerLength(combined);
  return {
    blocked: false,
    pending: pendingLength ? combined.slice(-pendingLength) : "",
    visible: pendingLength ? combined.slice(0, -pendingLength) : combined,
  };
}
