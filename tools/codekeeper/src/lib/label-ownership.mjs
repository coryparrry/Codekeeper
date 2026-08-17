export function isCodekeeperOwnedLabel(label) {
  return typeof label === "string" && label.startsWith("codekeeper:");
}
