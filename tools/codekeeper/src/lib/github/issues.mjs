export function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function issueLabelNames(issue) {
  if (!Array.isArray(issue?.labels)) throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid label metadata`);
  const names = issue.labels.map((label) => typeof label === "string" ? label : label?.name);
  if (names.some((label) => typeof label !== "string" || label.length === 0) || new Set(names).size !== names.length) {
    throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid or duplicate label metadata`);
  }
  return [...names].sort();
}

export function issueMutationSubject(issue) {
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

export const issueMethods = {
  async getIssue(number) {
    return (await this.request("GET", this.repoPath(`/issues/${number}`))).data;
  },

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
  },

  async listMaintenanceIssues(label = "maintenance") {
    const encoded = encodeURIComponent(label);
    const items = await this.paginate(this.repoPath(`/issues?state=all&labels=${encoded}&sort=updated&direction=desc`));
    return items.filter((item) => !item.pull_request);
  },

  async listOpenIssues(limit = 50) {
    return this.paginate(this.repoPath("/issues?state=open&sort=updated&direction=desc"), {
      limit,
      predicate: (item) => !item.pull_request
    });
  },

  async createIssue({ title, body, labels = [] }) {
    return (await this.request("POST", this.repoPath("/issues"), { body: { title, body, labels } })).data;
  },

  async updateIssue(number, changes) {
    const issue = (await this.request("PATCH", this.repoPath(`/issues/${number}`), { body: changes })).data;
    this.advanceSecondaryIssueMutation(issue);
    return issue;
  },

  async replaceManagedIssueLabels(number, desired, managed) {
    const expected = this.issueMutation;
    if (!expected || expected.number !== number || !expected.trackSubject) {
      throw new Error("Managed issue-label publication requires an active subject guard");
    }
    await this.replaceManagedLabels(number, desired, managed, "issue");
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
  },

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
  },

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
};
