import { automaticRepairMarker, sha256 } from "../markers.mjs";
import { frozenPullRepairReviewThreads, frozenPullRepairSubjectSha256 } from "../pull-repair-state.mjs";
import { completeReviewFeedback } from "../review-feedback.mjs";
import { isCodekeeperOwnedLabel } from "../label-ownership.mjs";
import {
  issueCommentInventory,
  issueMutationComment,
  isOwnedMarkerComment,
  normalizeAutomationIdentity,
  normalizeLogin,
} from "./comments.mjs";
import { issueLabelNames, issueMutationSubject, sameJson, sameStrings } from "./issues.mjs";
import { PULL_MUTATION_COMPENSATION } from "./transport.mjs";

function labelNames(subject) {
  return [...new Set((subject?.labels ?? []).map((label) =>
    String(typeof label === "string" ? label : label?.name ?? "").trim()
  ).filter(Boolean))].sort();
}

function hasPauseGuard(labels) {
  return labels.includes("codekeeper:paused") || labels.includes("paused");
}

export function isAmbiguousGitHubMutationError(error) {
  return error?.githubMutationOutcome === "ambiguous";
}

export const mutationGuardMethods = {
  assertNoMutationGuard() {
    if (this.pullMutation || this.branchMutation || this.issueMutation) {
      throw new Error("A conditional GitHub mutation is already active");
    }
  },

  async beginPullMutation({ repository, pullRequest, policy, reviewPublication = false }) {
    this.assertNoMutationGuard();
    if (repository !== this.repository) throw new Error("Conditional pull mutation repository does not match the GitHub client");
    if (!pullRequest || !Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) {
      throw new Error("Conditional pull mutation requires a pull request number");
    }
    if (typeof reviewPublication !== "boolean") {
      throw new Error("Conditional pull mutation review publication flag must be boolean");
    }
    if (!policy?.repository || !Array.isArray(policy.repository.ownerLogins)) {
      throw new Error("Conditional pull mutation requires repository policy");
    }
    const mutationPolicy = {
      repository: {
        defaultBranch: String(policy.repository.defaultBranch ?? ""),
        ownerLogins: policy.repository.ownerLogins.map(String)
      }
    };
    if (!mutationPolicy.repository.defaultBranch) {
      throw new Error("Conditional pull mutation requires the default branch policy");
    }
    const feedback = pullRequest.reviewFeedback ?? [];
    this.pullMutation = {
      number: pullRequest.number,
      repository,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      baseRef: pullRequest.baseRef ?? mutationPolicy.repository.defaultBranch,
      feedbackFrozen: pullRequest.reviewFeedbackFrozen === true || feedback.length > 0,
      feedbackSha256: sha256(JSON.stringify(feedback)),
      labels: null,
      addedLabels: new Set(),
      reviewPublication,
      policy: mutationPolicy
    };
    try {
      return await this.assertPullMutationCurrent({ captureLabels: true });
    } catch (error) {
      this.pullMutation = null;
      throw error;
    }
  },

  async beginPullRepairMutation({
    repository,
    target,
    policy,
    repairEvidencePolicy,
    rejectPaused = false
  }) {
    this.assertNoMutationGuard();
    if (repository !== this.repository) throw new Error("Conditional pull repair repository does not match the GitHub client");
    if (!target || !Number.isSafeInteger(target.number) || target.number <= 0) {
      throw new Error("Conditional pull repair requires a pull request target");
    }
    if (!policy?.repository || target.baseRef !== policy.repository.defaultBranch) {
      throw new Error("Conditional pull repair requires matching repository policy");
    }
    this.pullMutation = {
      number: target.number,
      repository,
      headSha: target.headSha,
      headRef: target.headRef,
      baseSha: target.baseSha,
      baseRef: target.baseRef,
      feedbackFrozen: false,
      feedbackSha256: null,
      labels: null,
      addedLabels: new Set(),
      policy: {
        repository: {
          defaultBranch: policy.repository.defaultBranch,
          ownerLogins: (policy.repository.ownerLogins ?? []).map(String)
        }
      },
      repair: {
        subjectSha256: target.subjectSha256,
        reviewThreadIds: [...target.reviewThreadIds],
        rejectPaused: rejectPaused === true,
        repairEvidencePolicy: structuredClone(repairEvidencePolicy)
      }
    };
    try {
      return await this.assertPullMutationCurrent({ captureLabels: true });
    } catch (error) {
      this.pullMutation = null;
      throw error;
    }
  },

  async beginBranchMutation({ branch, headSha }) {
    this.assertNoMutationGuard();
    if (typeof branch !== "string" || !branch || !/^[0-9a-f]{40}$/i.test(String(headSha ?? ""))) {
      throw new Error("Conditional branch mutation requires a branch and full head SHA");
    }
    this.branchMutation = { branch, headSha: String(headSha).toLowerCase() };
    try {
      await this.assertMutationCurrent();
    } catch (error) {
      this.branchMutation = null;
      throw error;
    }
  },

  async beginIssueMutation({
    issue,
    rejectPaused = false,
    trackSubject = false,
    trackComments = false,
    allowClosed = false,
  }) {
    this.assertNoMutationGuard();
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0 || typeof issue.updatedAt !== "string") {
      throw new Error("Conditional issue mutation requires a frozen issue number and timestamp");
    }
    this.issueMutation = {
      number: issue.number,
      updatedAt: issue.updatedAt,
      rejectPaused: rejectPaused === true,
      subject: null,
      labels: null,
      comments: null,
      prerequisites: [],
      trackSubject: trackSubject === true,
      trackComments: trackComments === true,
      allowClosed: allowClosed === true,
    };
    try {
      const live = await this.assertMutationCurrent();
      this.issueMutation.subject = issueMutationSubject(live);
      this.issueMutation.labels = this.issueMutation.trackSubject ? issueLabelNames(live) : null;
      if (this.issueMutation.trackComments) {
        this.issueMutation.comments = issueCommentInventory(
          await this.listIssueComments(issue.number),
          issue.number
        );
      }
      return live;
    } catch (error) {
      this.issueMutation = null;
      throw error;
    }
  },

  async beginSecondaryIssueMutation({ issue, allowClosed = issue?.state === "closed" }) {
    if (this.secondaryIssueMutation) {
      throw new Error("A conditional secondary issue mutation is already active");
    }
    if (
      !issue || issue.pull_request || !Number.isSafeInteger(issue.number) || issue.number <= 0 ||
      typeof issue.updated_at !== "string" || !Number.isFinite(Date.parse(issue.updated_at))
    ) {
      throw new Error("Conditional secondary issue mutation requires a frozen issue snapshot");
    }
    this.secondaryIssueMutation = {
      number: issue.number,
      updatedAt: issue.updated_at,
      subject: issueMutationSubject(issue),
      labels: issueLabelNames(issue),
      comments: null,
      allowClosed: allowClosed === true,
    };
    try {
      const live = await this.assertSecondaryIssueMutationCurrent();
      this.secondaryIssueMutation.comments = issueCommentInventory(
        await this.listIssueComments(issue.number),
        issue.number
      );
      return live;
    } catch (error) {
      this.secondaryIssueMutation = null;
      throw error;
    }
  },

  endSecondaryIssueMutation() {
    this.secondaryIssueMutation = null;
  },

  async assertSecondaryIssueMutationCurrent() {
    const expected = this.secondaryIssueMutation;
    if (!expected) return null;
    const [issue, comments] = await Promise.all([
      this.getIssue(expected.number),
      expected.comments === null ? Promise.resolve(null) : this.listIssueComments(expected.number)
    ]);
    if (
      issue.pull_request ||
      (issue.state !== "open" && !(expected.allowClosed && issue.state === "closed"))
    ) {
      throw new Error(`Issue #${expected.number} is no longer eligible`);
    }
    if (!sameJson(issueMutationSubject(issue), expected.subject)) {
      throw new Error(`Issue #${expected.number} changed after inventory; stale reconciliation will not mutate GitHub`);
    }
    if (!sameStrings(issueLabelNames(issue), expected.labels)) {
      throw new Error(`Issue #${expected.number} labels changed after inventory`);
    }
    if (issue.updated_at !== expected.updatedAt) {
      throw new Error(`Issue #${expected.number} changed after inventory; stale reconciliation will not mutate GitHub`);
    }
    if (expected.comments !== null && !sameJson(
      issueCommentInventory(comments, expected.number),
      expected.comments
    )) {
      throw new Error(`Issue #${expected.number} comments changed after inventory`);
    }
    return issue;
  },

  advanceSecondaryIssueMutation(issue) {
    const expected = this.secondaryIssueMutation;
    if (!expected || issue?.number !== expected.number) return;
    if (typeof issue.updated_at !== "string" || !Number.isFinite(Date.parse(issue.updated_at))) {
      throw new Error(`Issue #${expected.number} has no updated timestamp after secondary reconciliation`);
    }
    expected.updatedAt = issue.updated_at;
    expected.subject = issueMutationSubject(issue);
    expected.labels = issueLabelNames(issue);
  },

  async advanceSecondaryIssueMutationLabels(number, labels) {
    const expected = this.secondaryIssueMutation;
    if (!expected || expected.number !== number) return;
    const after = await this.getIssue(number);
    if (!sameJson(issueMutationSubject(after), expected.subject)) {
      throw new Error(`Issue #${number} changed while Codekeeper reconciled labels`);
    }
    if (!sameStrings(issueLabelNames(after), labels)) {
      throw new Error(`Issue #${number} labels changed while Codekeeper reconciled labels`);
    }
    this.advanceSecondaryIssueMutation(after);
  },

  async assertPrimaryMutationCurrent() {
    if (this.pullMutation) return this.assertPullMutationCurrent();
    if (this.branchMutation) {
      const branch = await this.getBranch(this.branchMutation.branch);
      const current = String(branch?.commit?.sha ?? "").toLowerCase();
      if (current !== this.branchMutation.headSha) {
        throw new Error(
          `Remote branch ${this.branchMutation.branch} moved from ${this.branchMutation.headSha} to ${current || "missing"}; stale publication will not mutate GitHub`
        );
      }
      return branch;
    }
    if (this.issueMutation) {
      const [issue, ...prerequisites] = await Promise.all([
        this.getIssue(this.issueMutation.number),
        ...this.issueMutation.prerequisites.map((item) => this.getIssue(item.number))
      ]);
      if (
        issue.pull_request ||
        (issue.state !== "open" && !(this.issueMutation.allowClosed && issue.state === "closed"))
      ) {
        throw new Error(`Issue #${this.issueMutation.number} is no longer eligible`);
      }
      if (this.issueMutation.rejectPaused && hasPauseGuard(issueLabelNames(issue))) {
        throw new Error(`Issue #${issue.number} is paused; automatic publication stopped`);
      }
      if (this.issueMutation.trackSubject && this.issueMutation.subject !== null &&
          !sameJson(issueMutationSubject(issue), this.issueMutation.subject)) {
        throw new Error(`Issue #${issue.number} changed while Codekeeper published; stale action will not mutate GitHub`);
      }
      if (this.issueMutation.labels !== null && !sameStrings(issueLabelNames(issue), this.issueMutation.labels)) {
        throw new Error(`Issue #${issue.number} labels changed while Codekeeper published`);
      }
      if (this.issueMutation.trackComments && this.issueMutation.comments !== null) {
        const comments = issueCommentInventory(await this.listIssueComments(issue.number), issue.number);
        if (!sameJson(comments, this.issueMutation.comments)) {
          throw new Error(`Issue #${issue.number} comments changed while Codekeeper published`);
        }
      }
      if (issue.updated_at !== this.issueMutation.updatedAt) {
        const phase = this.issueMutation.trackComments ? "while Codekeeper reconciled comments" : "after implementation started";
        throw new Error(`Issue #${issue.number} changed ${phase}; stale action will not publish`);
      }
      for (let index = 0; index < prerequisites.length; index += 1) {
        const expected = this.issueMutation.prerequisites[index];
        const current = prerequisites[index];
        if (current?.pull_request || current?.state !== "open" ||
            current.updated_at !== expected.updatedAt ||
            !sameJson(issueMutationSubject(current), expected.subject)) {
          throw new Error(`Issue #${expected.number} changed after duplicate assessment; stale action will not publish`);
        }
      }
      return issue;
    }
    return null;
  },

  async assertMutationCurrent() {
    const primary = await this.assertPrimaryMutationCurrent();
    const secondary = await this.assertSecondaryIssueMutationCurrent();
    return primary ?? secondary;
  },

  advanceIssueMutationLabels(labels, updatedAt) {
    const expected = this.issueMutation;
    if (!expected) return;
    expected.labels = [...new Set(labels.map(String))].sort();
    expected.updatedAt = updatedAt;
  },

  advanceIssueMutationComment(comment, expectedBody, authorIdentity, updatedAt) {
    const expected = this.issueMutation;
    if (!expected?.trackComments) return;
    const identity = normalizeAutomationIdentity(authorIdentity);
    const mutation = issueMutationComment(comment, expected.number);
    if (!identity || !isOwnedMarkerComment(comment, expectedBody.slice(expectedBody.lastIndexOf("\n") + 1), identity) || mutation.body !== expectedBody) {
      throw new Error(`Issue #${expected.number} changed while Codekeeper reconciled comments`);
    }
    const comments = new Map(expected.comments.map((item) => [item.id, item]));
    comments.set(mutation.id, mutation);
    expected.comments = [...comments.values()].sort((left, right) => left.id - right.id);
    expected.updatedAt = updatedAt;
  },

  async rebaseIssueMutationAfterComment(number) {
    const expected = this.issueMutation;
    if (!expected || expected.number !== number) return null;
    const issue = await this.getIssue(number);
    if (typeof issue.updated_at !== "string" || !Number.isFinite(Date.parse(issue.updated_at))) {
      throw new Error(`Issue #${number} has no updated timestamp after comment reconciliation`);
    }
    const previousUpdatedAt = expected.updatedAt;
    expected.updatedAt = issue.updated_at;
    try {
      return await this.assertMutationCurrent();
    } catch (error) {
      expected.updatedAt = previousUpdatedAt;
      throw error;
    }
  },

  async verifyIssueMutation() {
    return this.assertMutationCurrent();
  },

  async mutateIfCurrent(operation) {
    if (typeof operation !== "function") throw new TypeError("Conditional mutation operation must be a function");
    await this.assertMutationCurrent();
    return operation();
  },

  async mutatePullHeadIfCurrent(headSha, operation) {
    if (!this.pullMutation?.repair || !/^[0-9a-f]{40}$/i.test(String(headSha ?? ""))) {
      throw new Error("Conditional pull-head mutation requires an active repair and full commit SHA");
    }
    const result = await this.mutateIfCurrent(operation);
    if (result !== headSha) throw new Error(`PR repair pushed ${result}; expected ${headSha}`);
    this.pullMutation.headSha = headSha;
    this.pullMutation.repair = null;
    return result;
  },

  async assertPullMutationCurrent({ captureLabels = false } = {}) {
    const expected = this.pullMutation;
    if (!expected) return null;
    const [pull, feedback, comments, liveReviewThreads, branch] = await Promise.all([
      this.getPull(expected.number),
      expected.feedbackFrozen
        ? completeReviewFeedback(this, expected.number, expected.policy)
        : Promise.resolve([]),
      expected.repair ? this.listIssueComments(expected.number) : Promise.resolve([]),
      expected.repair?.reviewThreadIds.length > 0
        ? this.listPullReviewThreads(expected.number)
        : Promise.resolve([]),
      expected.repair ? this.getBranch(expected.headRef) : Promise.resolve(null)
    ]);
    this.assertPullMutationIdentity(pull);
    const currentLabels = labelNames(pull);
    if (hasPauseGuard(currentLabels)) {
      const error = new Error(`PR #${pull.number} is paused; publication will not mutate GitHub`);
      if (expected.repair?.rejectPaused) error.code = "CODEKEEPER_PAUSED";
      throw error;
    }
    if (captureLabels || expected.labels === null) {
      expected.labels = currentLabels;
    } else if (!sameStrings(currentLabels, expected.labels)) {
      throw new Error(`PR #${pull.number} labels changed; stale publication will not mutate GitHub`);
    }
    if (expected.feedbackFrozen && sha256(JSON.stringify(feedback)) !== expected.feedbackSha256) {
      throw new Error(`PR #${pull.number} review feedback changed after preparation; stale publication will not mutate GitHub`);
    }
    if (expected.repair) {
      const evidencePolicy = expected.repair.repairEvidencePolicy;
      if (evidencePolicy.authorizationMode === "policy") {
        const actor = normalizeLogin(evidencePolicy.actor);
        const marker = automaticRepairMarker(expected.headSha);
        const authorized = comments.some((comment) =>
          comment?.user?.type === "Bot" &&
          normalizeLogin(comment?.user?.login) === actor &&
          typeof comment?.body === "string" &&
          comment.body.endsWith(marker)
        );
        if (!authorized) throw new Error(`PR #${pull.number} no longer has policy repair authorization`);
      }
      const reviewThreads = frozenPullRepairReviewThreads(liveReviewThreads, expected.repair.reviewThreadIds);
      if (frozenPullRepairSubjectSha256(pull, comments, reviewThreads, evidencePolicy) !== expected.repair.subjectSha256) {
        throw new Error(`PR #${pull.number} repair evidence changed after implementation started`);
      }
      if (!branch) throw new Error(`PR #${pull.number} head branch ${expected.headRef} no longer exists`);
      if (branch.protected) throw new Error(`PR #${pull.number} head branch ${expected.headRef} is protected`);
      if (branch.commit?.sha !== expected.headSha) {
        throw new Error(`PR #${pull.number} head branch moved from ${expected.headSha} to ${branch.commit?.sha ?? "missing"}`);
      }
    }
    return pull;
  },

  advancePullMutationState(method, endpoint, body) {
    const expected = this.pullMutation;
    if (!expected || expected.labels === null) return;
    const labelEndpoint = this.repoPath(`/issues/${expected.number}/labels`);
    if (method === "POST" && endpoint === labelEndpoint && Array.isArray(body?.labels)) {
      const additions = body.labels.map(String);
      additions.filter((label) => !expected.labels.includes(label)).forEach((label) => expected.addedLabels.add(label));
      expected.labels = [...new Set([...expected.labels, ...additions])].sort();
      return;
    }
    if (method === "DELETE" && endpoint.startsWith(`${labelEndpoint}/`)) {
      const removed = decodeURIComponent(endpoint.slice(labelEndpoint.length + 1));
      expected.labels = expected.labels.filter((label) => label !== removed);
      expected.addedLabels.delete(removed);
      return;
    }
    if (method === "PATCH" && endpoint === this.repoPath(`/issues/${expected.number}`) && Array.isArray(body?.labels)) {
      expected.labels = [...new Set(body.labels.map(String))].sort();
    }
  },

  async rollbackPullLabel(number, label) {
    if (!isCodekeeperOwnedLabel(label)) {
      throw new Error(`Cannot roll back label outside Codekeeper ownership: ${label}`);
    }
    const expected = this.pullMutation;
    if (!expected || number !== expected.number || !expected.addedLabels.has(label)) {
      throw new Error(`Cannot roll back unowned conditional label ${label}`);
    }
    const pull = await this.getPull(number);
    this.assertPullMutationIdentity(pull);
    try {
      await this.request(
        "DELETE",
        this.repoPath(`/issues/${number}/labels/${encodeURIComponent(label)}`),
        { guardToken: PULL_MUTATION_COMPENSATION }
      );
    } catch (error) {
      if (error.status !== 404) throw error;
      expected.labels = expected.labels.filter((item) => item !== label);
      expected.addedLabels.delete(label);
    }
  }
};
