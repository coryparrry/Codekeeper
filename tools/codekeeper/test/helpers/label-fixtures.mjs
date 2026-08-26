import {
  isCodekeeperIssueLabel,
  isCodekeeperLifecycleLabel,
  isCodekeeperPullRequestLabel,
} from "../../src/lib/label-ownership.mjs";

const MODE_OWNED = Object.freeze({
  issue: isCodekeeperIssueLabel,
  "pull-request": isCodekeeperPullRequestLabel,
  lifecycle: isCodekeeperLifecycleLabel,
});

export function reconcileFixtureLabels(existing, desired, mode) {
  const owned = MODE_OWNED[mode];
  if (!owned) throw new Error(`Unknown label fixture mode: ${mode}`);
  return [
    ...existing.filter((label) => !owned(label.name)),
    ...desired.map((name) => ({ name })),
  ];
}
