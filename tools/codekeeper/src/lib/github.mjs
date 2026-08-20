import { automaticRepairMarker, sha256 } from "./markers.mjs";
import { frozenPullRepairReviewThreads, frozenPullRepairSubjectSha256 } from "./pull-repair-state.mjs";
import { completeReviewFeedback } from "./review-feedback.mjs";
import { isCodekeeperOwnedLabel } from "./label-ownership.mjs";
import {
  graphql as executeGitHubGraphql,
  paginateGraphqlConnection,
  resolveGraphqlUrl,
} from "./github/graphql.mjs";
import {
  listIssueCommentWindow as fetchIssueCommentWindow,
  paginate as paginateGitHub,
} from "./github/pagination.mjs";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  ISSUE_MUTATION_INTERNAL,
  PULL_MUTATION_COMPENSATION,
  fetchWithRetry as fetchGitHubWithRetry,
  positiveFiniteNumber,
  request as executeGitHubRequest,
  retryAttempts,
  retryDelay as githubRetryDelay,
  sleep,
} from "./github/transport.mjs";

export { resolveGraphqlUrl };

function labelNames(subject) {
  return [...new Set((subject?.labels ?? []).map((label) =>
    String(typeof label === "string" ? label : label?.name ?? "").trim()
  ).filter(Boolean))].sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function issueLabelNames(issue) {
  if (!Array.isArray(issue?.labels)) throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid label metadata`);
  const names = issue.labels.map((label) => typeof label === "string" ? label : label?.name);
  if (names.some((label) => typeof label !== "string" || label.length === 0) || new Set(names).size !== names.length) {
    throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid or duplicate label metadata`);
  }
  return [...names].sort();
}

function hasPauseGuard(labels) {
  return labels.includes("codekeeper:paused") || labels.includes("paused");
}

function issueMutationSubject(issue) {
  return {
    number: issue?.number,
    title: issue?.title ?? null,
    body: issue?.body ?? null,
    state: issue?.state ?? null,
    stateReason: issue?.state_reason ?? null,
    locked: issue?.locked ?? null,
    activeLockReason: issue?.active_lock_reason ?? null,
    htmlUrl: issue?.html_url ?? null,
    author: {
      id: issue?.user?.id ?? null,
      login: issue?.user?.login ?? null,
      type: issue?.user?.type ?? null
    },
    assignees: (issue?.assignees ?? [])
      .map((assignee) => ({ id: assignee?.id ?? null, login: assignee?.login ?? null, type: assignee?.type ?? null }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    milestone: issue?.milestone?.number ?? null
  };
}

function issueMutationComment(comment, issueNumber) {
  const id = Number(comment?.id);
  const createdAt = comment?.created_at;
  const updatedAt = comment?.updated_at;
  if (
    !Number.isSafeInteger(id) || id <= 0 ||
    typeof comment?.body !== "string" ||
    typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
    typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new Error(`Issue #${issueNumber} has invalid comment metadata`);
  }
  return {
    id,
    body: comment.body,
    createdAt,
    updatedAt,
    author: {
      id: comment?.user?.id ?? null,
      login: comment?.user?.login ?? null,
      type: comment?.user?.type ?? null
    }
  };
}

function issueCommentInventory(comments, issueNumber) {
  if (!Array.isArray(comments)) throw new Error(`Issue #${issueNumber} has invalid comment inventory`);
  const inventory = comments
    .map((comment) => issueMutationComment(comment, issueNumber))
    .sort((left, right) => left.id - right.id);
  if (new Set(inventory.map((comment) => comment.id)).size !== inventory.length) {
    throw new Error(`Issue #${issueNumber} has duplicate comment metadata`);
  }
  return inventory;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}


function normalizeLogin(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeAutomationIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const login = normalizeLogin(identity.login);
  const id = String(identity.id ?? "").trim();
  if (!login.endsWith("[bot]") || !/^[1-9]\d*$/.test(id)) return null;
  return { login, id };
}

export function isOwnedMarkerComment(comment, marker, authorIdentity) {
  const expectedAuthor = normalizeAutomationIdentity(authorIdentity);
  return Boolean(
    expectedAuthor &&
    comment?.user?.type === "Bot" &&
    normalizeLogin(comment.user?.login) === expectedAuthor.login &&
    String(comment.user?.id ?? "") === expectedAuthor.id &&
    typeof comment?.body === "string" &&
    comment.body.endsWith(marker)
  );
}

export function isAmbiguousGitHubMutationError(error) {
  return error?.githubMutationOutcome === "ambiguous";
}

export class GitHubClient {
  constructor({
    token,
    repository = process.env.GITHUB_REPOSITORY,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    graphqlUrl,
    transport = {}
  }) {
    if (!token) throw new Error("GitHub token is required");
    if (!repository || !repository.includes("/")) throw new Error("Repository must be owner/name");
    const [owner, repo] = repository.split("/", 2);
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.graphqlUrl = resolveGraphqlUrl(this.apiUrl, graphqlUrl);
    this.fetch = typeof transport.fetch === "function" ? transport.fetch : globalThis.fetch;
    this.requestTimeoutMs = positiveFiniteNumber(transport.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.retryAttempts = retryAttempts(transport.retries, DEFAULT_RETRY_ATTEMPTS);
    this.sleep = typeof transport.sleep === "function" ? transport.sleep : sleep;
    this.now = typeof transport.now === "function" ? transport.now : Date.now;
    this.pullMutation = null;
    this.branchMutation = null;
    this.issueMutation = null;
    this.secondaryIssueMutation = null;
  }

  assertNoMutationGuard() {
    if (this.pullMutation || this.branchMutation || this.issueMutation) {
      throw new Error("A conditional GitHub mutation is already active");
    }
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  endSecondaryIssueMutation() {
    this.secondaryIssueMutation = null;
  }

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
  }

  advanceSecondaryIssueMutation(issue) {
    const expected = this.secondaryIssueMutation;
    if (!expected || issue?.number !== expected.number) return;
    if (typeof issue.updated_at !== "string" || !Number.isFinite(Date.parse(issue.updated_at))) {
      throw new Error(`Issue #${expected.number} has no updated timestamp after secondary reconciliation`);
    }
    expected.updatedAt = issue.updated_at;
    expected.subject = issueMutationSubject(issue);
    expected.labels = issueLabelNames(issue);
  }

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
  }

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
  }

  async assertMutationCurrent() {
    const primary = await this.assertPrimaryMutationCurrent();
    const secondary = await this.assertSecondaryIssueMutationCurrent();
    return primary ?? secondary;
  }

  advanceIssueMutationLabels(labels, updatedAt) {
    const expected = this.issueMutation;
    if (!expected) return;
    expected.labels = [...new Set(labels.map(String))].sort();
    expected.updatedAt = updatedAt;
  }

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
  }

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
  }

  async verifyIssueMutation() {
    return this.assertMutationCurrent();
  }

  async replaceManagedIssueLabels(number, desired, managed) {
    const expected = this.issueMutation;
    if (!expected || expected.number !== number || !expected.trackSubject) {
      throw new Error("Managed issue-label publication requires an active subject guard");
    }
    await this.replaceManagedLabels(number, desired, managed);
    const after = await this.getIssue(number);
    if (!sameJson(issueMutationSubject(after), expected.subject)) {
      throw new Error(`Issue #${number} changed while Codekeeper reconciled labels`);
    }
    const managedSet = new Set(managed);
    const labels = [...new Set([
      ...expected.labels.filter((label) => !managedSet.has(label)),
      ...desired
    ])].sort();
    if (!sameStrings(issueLabelNames(after), labels)) {
      throw new Error(`Issue #${number} labels changed while Codekeeper reconciled labels`);
    }
    if (typeof after.updated_at !== "string" || !Number.isFinite(Date.parse(after.updated_at))) {
      throw new Error(`Issue #${number} has no updated timestamp after label reconciliation`);
    }
    this.advanceIssueMutationLabels(labels, after.updated_at);
    return after;
  }

  async upsertOwnedIssueMarker(number, marker, body, authorIdentity) {
    const expected = this.issueMutation;
    if (!expected || expected.number !== number || !expected.trackComments) {
      throw new Error("Issue marker publication requires an active comment-inventory guard");
    }
    const content = `${body}\n${marker}`;
    const mutation = await this.upsertMarkerComment(number, marker, body, authorIdentity);
    this.advanceIssueMutationComment(
      mutation,
      content,
      authorIdentity,
      mutation?.updated_at ?? mutation?.created_at
    );
    await this.rebaseIssueMutationAfterComment(number);
    return mutation;
  }

  async requireOpenIssueMutationPrerequisite(number) {
    if (!this.issueMutation || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error("An active issue mutation and related issue number are required");
    }
    const issue = await this.getIssue(number);
    if (issue.pull_request || issue.state !== "open") throw new Error(`Issue #${number} is no longer eligible`);
    if (typeof issue.updated_at !== "string" || !Number.isFinite(Date.parse(issue.updated_at))) {
      throw new Error(`Issue #${number} has no valid update timestamp`);
    }
    this.issueMutation.prerequisites.push({
      number,
      updatedAt: issue.updated_at,
      subject: issueMutationSubject(issue)
    });
    return issue;
  }

  async mutateIfCurrent(operation) {
    if (typeof operation !== "function") throw new TypeError("Conditional mutation operation must be a function");
    await this.assertMutationCurrent();
    return operation();
  }

  async mutatePullHeadIfCurrent(headSha, operation) {
    if (!this.pullMutation?.repair || !/^[0-9a-f]{40}$/i.test(String(headSha ?? ""))) {
      throw new Error("Conditional pull-head mutation requires an active repair and full commit SHA");
    }
    const result = await this.mutateIfCurrent(operation);
    if (result !== headSha) throw new Error(`PR repair pushed ${result}; expected ${headSha}`);
    this.pullMutation.headSha = headSha;
    this.pullMutation.repair = null;
    return result;
  }

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
  }

  assertPullMutationIdentity(pull) {
    const expected = this.pullMutation;
    if (!expected) throw new Error("No conditional pull mutation is active");
    if (pull.state !== "open") throw new Error(`PR #${pull.number} is not open`);
    if (pull.draft) throw new Error(`PR #${pull.number} is a draft; stale publication will not mutate GitHub`);
    if (pull.head?.sha !== expected.headSha) {
      throw new Error(`PR #${pull.number} head SHA changed from ${expected.headSha} to ${pull.head?.sha}; stale publication will not mutate GitHub`);
    }
    if (expected.headRef && pull.head?.ref !== expected.headRef) {
      throw new Error(`PR #${pull.number} head branch changed from ${expected.headRef} to ${pull.head?.ref ?? "missing"}`);
    }
    if (pull.base?.sha !== expected.baseSha) {
      throw new Error(`PR #${pull.number} base SHA changed from ${expected.baseSha} to ${pull.base?.sha}; stale publication will not mutate GitHub`);
    }
    if (pull.base?.ref !== expected.baseRef || (!expected.reviewPublication && pull.base?.ref !== expected.policy.repository.defaultBranch)) {
      throw new Error(`PR #${pull.number} base branch changed; stale publication will not mutate GitHub`);
    }
    if (pull.head?.repo?.full_name !== expected.repository || pull.base?.repo?.full_name !== expected.repository) {
      throw new Error(`PR #${pull.number} head repository changed; stale publication will not mutate GitHub`);
    }
  }

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
  }

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

  retryDelay(response, attempt) {
    return githubRetryDelay(this, response, attempt);
  }

  async fetchWithRetry(url, options, extras) {
    return fetchGitHubWithRetry(this, url, options, extras);
  }

  async request(method, endpoint, options) {
    return executeGitHubRequest(this, method, endpoint, options);
  }

  async paginate(endpoint, options) {
    return paginateGitHub(this, endpoint, options);
  }

  repoPath(suffix) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
  }

  async getPull(number, { expectedHeadSha } = {}) {
    return (await this.request("GET", this.repoPath(`/pulls/${number}`), {
      retryPayload: expectedHeadSha
        ? ({ response, payload }) => response.ok && payload?.head?.sha !== expectedHeadSha
        : undefined
    })).data;
  }

  async getIssue(number) {
    return (await this.request("GET", this.repoPath(`/issues/${number}`))).data;
  }

  async getUser(login) {
    const normalized = String(login ?? "").trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(normalized)) {
      throw new Error("GitHub user login is invalid");
    }
    return (await this.request("GET", `/users/${encodeURIComponent(normalized)}`)).data;
  }

  async getApp(slug) {
    const normalized = String(slug ?? "").trim();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(normalized)) {
      throw new Error("GitHub App slug is invalid");
    }
    return (await this.request("GET", `/apps/${encodeURIComponent(normalized)}`)).data;
  }

  async listPullFiles(number, limit) {
    return this.paginate(this.repoPath(`/pulls/${number}/files`), { limit });
  }

  async listPullReviews(number, limit = 100) {
    return this.paginate(this.repoPath(`/pulls/${number}/reviews`), { limit });
  }

  async getReviewComment(commentId) {
    return (await this.request("GET", this.repoPath(`/pulls/comments/${commentId}`))).data;
  }

  async getIssueComment(commentId) {
    if (!/^[1-9][0-9]*$/.test(String(commentId ?? ""))) {
      throw new Error("Issue comment ID must be a positive integer");
    }
    return (await this.request("GET", this.repoPath(`/issues/comments/${commentId}`))).data;
  }

  async listPullReviewComments(number) {
    return this.paginate(this.repoPath(`/pulls/${number}/comments`));
  }

  async listPullReviewThreads(number, limit = 200) {
    const query = `
      query PullReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 100) {
                  nodes { id databaseId body url path line originalLine author { login } }
                  pageInfo { hasNextPage }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `;
    return paginateGraphqlConnection(this, {
      query,
      variables: { owner: this.owner, repo: this.repo, number },
      limit,
      getConnection: (data) => data?.repository?.pullRequest?.reviewThreads,
      invalidError: `PR #${number} has invalid review-thread metadata`,
      truncatedError: `PR #${number} has more than ${limit} review threads`,
      inspectNode(thread) {
        if (thread.comments?.pageInfo?.hasNextPage) {
          throw new Error(`PR #${number} has a review thread with more than 100 comments`);
        }
      }
    });
  }

  async listIssueComments(number) {
    return this.paginate(this.repoPath(`/issues/${number}/comments`));
  }

  async listIssueCommentWindow(number, triggerCommentId, limit) {
    return fetchIssueCommentWindow(this, number, triggerCommentId, limit);
  }

  async listOpenPulls(limit = Number.POSITIVE_INFINITY) {
    return this.paginate(this.repoPath("/pulls?state=open&sort=updated&direction=desc"), { limit });
  }

  async listMergedPullRequestsClosingIssue(number, limit = 100) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Issue number must be a positive integer");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) throw new Error("Closing pull request limit must be between 1 and 100");
    const query = `
      query ClosingPullRequests($owner: String!, $repo: String!, $number: Int!, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            closedByPullRequestsReferences(first: $first, includeClosedPrs: true) {
              nodes { number url merged mergedAt repository { nameWithOwner } }
              pageInfo { hasNextPage }
            }
          }
        }
      }
    `;
    const data = await this.graphql(query, { owner: this.owner, repo: this.repo, number, first: limit });
    const connection = data?.repository?.issue?.closedByPullRequestsReferences;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error(`Issue #${number} has invalid closing pull request metadata`);
    }
    if (connection.pageInfo?.hasNextPage) {
      throw new Error(`Issue #${number} has more than ${limit} closing pull request references`);
    }
    return connection.nodes
      .filter((pull) => pull?.merged === true && typeof pull.mergedAt === "string" && pull.mergedAt)
      .map((pull) => ({
        number: pull.number,
        url: pull.url,
        mergedAt: pull.mergedAt,
        repository: pull.repository?.nameWithOwner ?? ""
      }))
      .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
  }

  async listMaintenanceIssues(label = "maintenance") {
    const encoded = encodeURIComponent(label);
    const items = await this.paginate(this.repoPath(`/issues?state=all&labels=${encoded}&sort=updated&direction=desc`));
    return items.filter((item) => !item.pull_request);
  }

  async listOpenIssues(limit = 50) {
    return this.paginate(this.repoPath("/issues?state=open&sort=updated&direction=desc"), {
      limit,
      predicate: (item) => !item.pull_request
    });
  }

  async createIssue({ title, body, labels = [] }) {
    return (await this.request("POST", this.repoPath("/issues"), { body: { title, body, labels } })).data;
  }

  async updateIssue(number, changes) {
    const issue = (await this.request("PATCH", this.repoPath(`/issues/${number}`), { body: changes })).data;
    this.advanceSecondaryIssueMutation(issue);
    return issue;
  }

  async createComment(number, body) {
    return (await this.request("POST", this.repoPath(`/issues/${number}/comments`), { body: { body } })).data;
  }

  async updateComment(commentId, body) {
    return (await this.request("PATCH", this.repoPath(`/issues/comments/${commentId}`), { body: { body } })).data;
  }

  async createReviewReply(number, commentId, body) {
    return (await this.request("POST", this.repoPath(`/pulls/${number}/comments/${commentId}/replies`), { body: { body } })).data;
  }

  async updateReviewComment(commentId, body) {
    return (await this.request("PATCH", this.repoPath(`/pulls/comments/${commentId}`), { body: { body } })).data;
  }

  async upsertReviewReply(number, commentId, marker, body, authorIdentity) {
    const expectedAuthor = normalizeAutomationIdentity(authorIdentity);
    if (!expectedAuthor) throw new Error("A configured GitHub App bot identity is required for review replies");
    const comments = await this.listPullReviewComments(number);
    const existing = comments.find((comment) =>
      Number(comment.in_reply_to_id) === Number(commentId) &&
      isOwnedMarkerComment(comment, marker, expectedAuthor)
    );
    const content = `${body}\n${marker}`;
    return existing
      ? this.updateReviewComment(existing.id, content)
      : this.createReviewReply(number, commentId, content);
  }

  async upsertMarkerComment(number, marker, body, authorIdentity) {
    const expectedAuthor = normalizeAutomationIdentity(authorIdentity);
    if (!expectedAuthor) {
      throw new Error("A configured GitHub App bot identity is required for marker comments");
    }
    const comments = await this.listIssueComments(number);
    const existing = comments.find((comment) =>
      isOwnedMarkerComment(comment, marker, expectedAuthor)
    );
    const content = `${body}\n${marker}`;
    const mutation = existing ? await this.updateComment(existing.id, content) : await this.createComment(number, content);
    if (this.issueMutation?.number === number) {
      this.advanceIssueMutationComment(mutation, content, expectedAuthor, mutation.updated_at ?? mutation.created_at);
    }
    return mutation;
  }

  async createOwnedIssueComment(number, body, authorIdentity) {
    const expectedAuthor = normalizeAutomationIdentity(authorIdentity);
    if (!expectedAuthor) throw new Error("A configured GitHub App bot identity is required for issue comments");
    const mutation = await this.createComment(number, body);
    if (this.issueMutation?.number === number) {
      const normalized = issueMutationComment(mutation, number);
      if (
        mutation?.user?.type !== "Bot" ||
        normalizeLogin(mutation.user?.login) !== expectedAuthor.login ||
        String(mutation.user?.id ?? "") !== expectedAuthor.id ||
        normalized.body !== body
      ) {
        throw new Error(`Issue #${number} changed while Codekeeper reconciled comments`);
      }
      const comments = new Map(this.issueMutation.comments.map((item) => [item.id, item]));
      comments.set(normalized.id, normalized);
      this.issueMutation.comments = [...comments.values()].sort((left, right) => left.id - right.id);
      this.issueMutation.updatedAt = mutation.updated_at ?? mutation.created_at;
      await this.rebaseIssueMutationAfterComment(number);
    }
    return mutation;
  }

  async retireReviewFeedbackReply(number, marker, body, authorIdentity) {
    const expectedAuthor = normalizeAutomationIdentity(authorIdentity);
    if (!expectedAuthor) {
      throw new Error("A configured GitHub App bot identity is required to retire review replies");
    }
    const [comments, reviewComments] = await Promise.all([
      this.listIssueComments(number),
      this.listPullReviewComments(number)
    ]);
    const content = `${body}\n${marker}`;
    const updates = [
      ...comments
        .filter((comment) => isOwnedMarkerComment(comment, marker, expectedAuthor))
        .map((comment) => this.updateComment(comment.id, content)),
      ...reviewComments
        .filter((comment) => isOwnedMarkerComment(comment, marker, expectedAuthor))
        .map((comment) => this.updateReviewComment(comment.id, content))
    ];
    await Promise.all(updates);
    return updates.length;
  }

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
  }

  async ensureLabels(definitions, names) {
    for (const name of [...new Set(names)]) {
      const definition = definitions[name];
      if (!definition) throw new Error(`No label definition for ${name}`);
      await this.ensureLabel(name, definition);
    }
  }

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
  }

  async addLabels(number, labels) {
    const unique = [...new Set(labels)];
    if (unique.length === 0) return;
    const endpoint = this.repoPath(`/issues/${number}/labels`);
    try {
      await this.request("POST", endpoint, { body: { labels: unique } });
    } catch (error) {
      const expected = this.pullMutation;
      if (!isAmbiguousGitHubMutationError(error) || !expected || expected.number !== number) throw error;
      const pull = await this.getPull(number);
      this.assertPullMutationIdentity(pull);
      const reconciled = [...new Set([...expected.labels, ...unique])].sort();
      if (!sameStrings(labelNames(pull), reconciled)) throw error;
      this.advancePullMutationState("POST", endpoint, { labels: unique });
    }
  }

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

  async createRepositoryDispatch(eventType, clientPayload) {
    await this.request("POST", this.repoPath("/dispatches"), {
      body: { event_type: eventType, client_payload: clientPayload }
    });
  }

  async findOpenPullByHead(branch) {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    const pulls = await this.paginate(this.repoPath(`/pulls?state=open&head=${head}`), { limit: 1 });
    return pulls.find((pull) => pull.head?.ref === branch && pull.head?.repo?.full_name === this.repository) ?? null;
  }

  async getBranch(branch) {
    try {
      return (await this.request("GET", this.repoPath(`/branches/${encodeURIComponent(branch)}`))).data;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async getBranchTip(branch) {
    const branchData = await this.getBranch(branch);
    if (!branchData) return null;
    const treeSha = branchData?.commit?.commit?.tree?.sha;
    const parentShas = branchData?.commit?.parents?.map((parent) => parent?.sha);
    const headSha = branchData?.commit?.sha;
    if (typeof headSha !== "string" || typeof treeSha !== "string" || !Array.isArray(parentShas) || parentShas.some((sha) => typeof sha !== "string")) {
      throw new Error(`GitHub branch ${branch} has an invalid commit shape`);
    }
    return { headSha, treeSha, parentShas };
  }

  async deleteBranch(branch) {
    return this.request("DELETE", this.repoPath(`/git/refs/heads/${encodeURIComponent(branch)}`));
  }

  async createPull({ title, body, head, base, draft = true }) {
    return (
      await this.request("POST", this.repoPath("/pulls"), {
        body: { title, body, head, base, draft, maintainer_can_modify: true }
      })
    ).data;
  }

  async enableAutoMerge(pullRequestNodeId, mergeMethod = "SQUASH") {
    const query = `
      mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
          pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
        }
      }
    `;
    return this.graphql(query, { pullRequestId: pullRequestNodeId, mergeMethod });
  }

  async disableAutoMerge(pullRequestNodeId) {
    const query = `
      mutation DisableAutoMerge($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
        }
      }
    `;
    return this.graphql(query, { pullRequestId: pullRequestNodeId });
  }

  async resolveReviewThread(threadId) {
    const query = `
      mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id isResolved }
        }
      }
    `;
    return this.graphql(query, { threadId });
  }

  async graphql(query, variables) {
    return executeGitHubGraphql(this, query, variables);
  }
}
