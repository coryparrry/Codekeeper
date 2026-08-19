import { paginateGraphqlConnection } from "./graphql.mjs";

export const pullMethods = {
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
  },

  async getPull(number, { expectedHeadSha } = {}) {
    return (await this.request("GET", this.repoPath(`/pulls/${number}`), {
      retryPayload: expectedHeadSha
        ? ({ response, payload }) => response.ok && payload?.head?.sha !== expectedHeadSha
        : undefined
    })).data;
  },

  async listPullFiles(number, limit) {
    return this.paginate(this.repoPath(`/pulls/${number}/files`), { limit });
  },

  async listPullReviews(number, limit = 100) {
    return this.paginate(this.repoPath(`/pulls/${number}/reviews`), { limit });
  },

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
  },

  async listOpenPulls(limit = Number.POSITIVE_INFINITY) {
    return this.paginate(this.repoPath("/pulls?state=open&sort=updated&direction=desc"), { limit });
  },

  async findOpenPullByHead(branch) {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    const pulls = await this.paginate(this.repoPath(`/pulls?state=open&head=${head}`), { limit: 1 });
    return pulls.find((pull) => pull.head?.ref === branch && pull.head?.repo?.full_name === this.repository) ?? null;
  },

  async getBranch(branch) {
    try {
      return (await this.request("GET", this.repoPath(`/branches/${encodeURIComponent(branch)}`))).data;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  },

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
  },

  async deleteBranch(branch) {
    return this.request("DELETE", this.repoPath(`/git/refs/heads/${encodeURIComponent(branch)}`));
  },

  async createPull({ title, body, head, base, draft = true }) {
    return (
      await this.request("POST", this.repoPath("/pulls"), {
        body: { title, body, head, base, draft, maintainer_can_modify: true }
      })
    ).data;
  },

  async enableAutoMerge(pullRequestNodeId, mergeMethod = "SQUASH") {
    const query = `
      mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
          pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
        }
      }
    `;
    return this.graphql(query, { pullRequestId: pullRequestNodeId, mergeMethod });
  },

  async disableAutoMerge(pullRequestNodeId) {
    const query = `
      mutation DisableAutoMerge($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
        }
      }
    `;
    return this.graphql(query, { pullRequestId: pullRequestNodeId });
  },

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
};
