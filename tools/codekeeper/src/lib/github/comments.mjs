import { listIssueCommentWindow as fetchIssueCommentWindow } from "./pagination.mjs";

export function normalizeLogin(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeAutomationIdentity(identity) {
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

export function issueMutationComment(comment, issueNumber) {
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

export function issueCommentInventory(comments, issueNumber) {
  if (!Array.isArray(comments)) throw new Error(`Issue #${issueNumber} has invalid comment inventory`);
  const inventory = comments
    .map((comment) => issueMutationComment(comment, issueNumber))
    .sort((left, right) => left.id - right.id);
  if (new Set(inventory.map((comment) => comment.id)).size !== inventory.length) {
    throw new Error(`Issue #${issueNumber} has duplicate comment metadata`);
  }
  return inventory;
}

export const commentMethods = {
  async getReviewComment(commentId) {
    return (await this.request("GET", this.repoPath(`/pulls/comments/${commentId}`))).data;
  },

  async getIssueComment(commentId) {
    if (!/^[1-9][0-9]*$/.test(String(commentId ?? ""))) {
      throw new Error("Issue comment ID must be a positive integer");
    }
    return (await this.request("GET", this.repoPath(`/issues/comments/${commentId}`))).data;
  },

  async listPullReviewComments(number) {
    return this.paginate(this.repoPath(`/pulls/${number}/comments`));
  },

  async listIssueComments(number) {
    return this.paginate(this.repoPath(`/issues/${number}/comments`));
  },

  async listIssueCommentWindow(number, triggerCommentId, limit) {
    return fetchIssueCommentWindow(this, number, triggerCommentId, limit);
  },

  async createComment(number, body) {
    return (await this.request("POST", this.repoPath(`/issues/${number}/comments`), { body: { body } })).data;
  },

  async updateComment(commentId, body) {
    return (await this.request("PATCH", this.repoPath(`/issues/comments/${commentId}`), { body: { body } })).data;
  },

  async createReviewReply(number, commentId, body) {
    return (await this.request("POST", this.repoPath(`/pulls/${number}/comments/${commentId}/replies`), { body: { body } })).data;
  },

  async updateReviewComment(commentId, body) {
    return (await this.request("PATCH", this.repoPath(`/pulls/comments/${commentId}`), { body: { body } })).data;
  },

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
  },

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
  },

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
  },

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
};
