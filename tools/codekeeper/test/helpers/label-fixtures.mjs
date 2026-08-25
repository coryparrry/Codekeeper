import {
  isCodekeeperIssueLabel,
  isCodekeeperLifecycleLabel,
} from "../../src/lib/label-ownership.mjs";

export function reconcileFixtureLabels(existing, desired, mode) {
  const owned =
    mode === "lifecycle" ? isCodekeeperLifecycleLabel : isCodekeeperIssueLabel;
  return [
    ...existing.filter((label) => !owned(label.name)),
    ...desired.map((name) => ({ name })),
  ];
}
