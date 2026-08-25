import { isAmbiguousGitHubMutationError } from "../github.mjs";

function labelNames(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );
}

export function isDirectOwnerFix(context) {
  return (
    context?.authorizationMode === "owner" &&
    context?.ownerCommandContext?.executionKind === "mode" &&
    ["implement", "repair"].includes(
      context.ownerCommandContext.canonicalCommand,
    )
  );
}

/**
 * Preserve the established owner-command resume contract after removing the
 * assistant dispatch hop. The target is resumed only after the candidate is
 * sealed and the original command has reached trusted publication.
 */
export async function resumeDirectOwnerFix(github, context) {
  if (!isDirectOwnerFix(context)) return null;
  const number = context.target?.number;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Direct owner fix has no valid target");
  }
  const before = await github.getIssue(number);
  if (
    context.target.kind === "issue" &&
    before.updated_at !== context.issue?.updatedAt
  ) {
    throw new Error(
      `Issue #${number} changed after implementation started; stale action will not publish`,
    );
  }
  if (!labelNames(before).includes("codekeeper:paused")) return before;
  try {
    await github.removeLabel(number, "codekeeper:paused", "lifecycle");
  } catch (error) {
    if (isAmbiguousGitHubMutationError(error)) {
      try {
        const current = await github.getIssue(number);
        if (!labelNames(current).includes("codekeeper:paused")) {
          await github.addLabels(number, ["codekeeper:paused"]);
        }
      } catch (rollbackError) {
        throw new Error(
          `${error.message}; paused could not be restored: ${rollbackError.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  const resumed = await github.getIssue(number);
  if (labelNames(resumed).includes("codekeeper:paused")) {
    throw new Error(`Issue #${number} remains paused after the owner request`);
  }
  return resumed;
}
