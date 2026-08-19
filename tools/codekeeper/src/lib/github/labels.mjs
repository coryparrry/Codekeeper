import { isCodekeeperOwnedLabel } from "../label-ownership.mjs";
import { issueLabelNames, issueMutationSubject, sameJson, sameStrings } from "./issues.mjs";
import { ISSUE_MUTATION_INTERNAL } from "./transport.mjs";

export function labelNames(subject) {
  return [...new Set((subject?.labels ?? []).map((label) =>
    String(typeof label === "string" ? label : label?.name ?? "").trim()
  ).filter(Boolean))].sort();
}

export const labelMethods = {
  async ensureLabel(name, definition) {
    const endpoint = this.repoPath(`/labels/${encodeURIComponent(name)}`);
    try {
      await this.request("GET", endpoint);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await this.request("POST", this.repoPath("/labels"), {
          body: { name, color: definition.color, description: definition.description ?? "" }
        });
      } catch (createError) {
        if (createError.status !== 422) throw createError;
        await this.request("GET", endpoint);
      }
    }
  },

  async ensureLabels(definitions, names) {
    for (const name of [...new Set(names)]) {
      const definition = definitions[name];
      if (!definition) throw new Error(`No label definition for ${name}`);
      await this.ensureLabel(name, definition);
    }
  },

  async replaceManagedLabels(number, desired, managed) {
    const managedSet = new Set(managed);
    const desiredSet = new Set(desired);
    const nonCodekeeperManaged = [...managedSet].filter((label) => !isCodekeeperOwnedLabel(label));
    if (nonCodekeeperManaged.length > 0) {
      throw new Error(`Attempted to manage labels outside Codekeeper ownership: ${nonCodekeeperManaged.join(", ")}`);
    }
    const unmanaged = [...desiredSet].filter((label) => !managedSet.has(label));
    if (unmanaged.length > 0) {
      throw new Error(`Attempted to mutate labels outside configured ownership: ${unmanaged.join(", ")}`);
    }
    const secondary = this.secondaryIssueMutation?.number === number
      ? this.secondaryIssueMutation
      : null;
    const conditional = this.issueMutation?.number === number
      ? this.issueMutation
      : secondary;
    if (conditional) await this.assertMutationCurrent();
    const issue = await this.getIssue(number);
    const existing = (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
    const additions = [...desiredSet].filter((label) => !existing.includes(label));
    const expectedLabels = [...new Set([
      ...issueLabelNames(issue).filter((label) => !managedSet.has(label)),
      ...desiredSet
    ])].sort();
    let currentLabels = issueLabelNames(issue);
    if (additions.length > 0) {
      await this.request("POST", this.repoPath(`/issues/${number}/labels`), {
        body: { labels: additions },
        ...(secondary ? {} : conditional ? { guardToken: ISSUE_MUTATION_INTERNAL } : {})
      });
      currentLabels = [...new Set([...currentLabels, ...additions])].sort();
      if (secondary) await this.advanceSecondaryIssueMutationLabels(number, currentLabels);
    }
    for (const label of existing) {
      if (!managedSet.has(label) || desiredSet.has(label)) continue;
      try {
        await this.request("DELETE", this.repoPath(`/issues/${number}/labels/${encodeURIComponent(label)}`), {
          ...(secondary ? {} : conditional ? { guardToken: ISSUE_MUTATION_INTERNAL } : {})
        });
        currentLabels = currentLabels.filter((item) => item !== label);
        if (secondary) await this.advanceSecondaryIssueMutationLabels(number, currentLabels);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (conditional) {
      const after = await this.getIssue(number);
      if (!sameJson(issueMutationSubject(after), conditional.subject)) {
        throw new Error(`Issue #${number} changed while Codekeeper reconciled labels`);
      }
      if (!sameStrings(issueLabelNames(after), expectedLabels)) {
        throw new Error(`Issue #${number} labels changed while Codekeeper reconciled labels`);
      }
      if (typeof after.updated_at !== "string" || !Number.isFinite(Date.parse(after.updated_at))) {
        throw new Error(`Issue #${number} has no updated timestamp after label reconciliation`);
      }
      conditional.labels = expectedLabels;
      conditional.updatedAt = after.updated_at;
    }
  },

  async addLabels(number, labels) {
    const unique = [...new Set(labels)];
    if (unique.length === 0) return;
    const endpoint = this.repoPath(`/issues/${number}/labels`);
    try {
      await this.request("POST", endpoint, { body: { labels: unique } });
    } catch (error) {
      const expected = this.pullMutation;
      if (error?.githubMutationOutcome !== "ambiguous" || !expected || expected.number !== number) throw error;
      const pull = await this.getPull(number);
      this.assertPullMutationIdentity(pull);
      const reconciled = [...new Set([...expected.labels, ...unique])].sort();
      if (!sameStrings(labelNames(pull), reconciled)) throw error;
      this.advancePullMutationState("POST", endpoint, { labels: unique });
    }
  },

  async removeLabel(number, label) {
    if (!isCodekeeperOwnedLabel(label)) {
      throw new Error(`Attempted to remove label outside Codekeeper ownership: ${label}`);
    }
    try {
      await this.request("DELETE", this.repoPath(`/issues/${number}/labels/${encodeURIComponent(label)}`));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
};
