export const MAX_PAGINATION_PAGES = 1_000;
export const RECENT_ISSUE_COMMENT_PAGE_BUDGET = 3;

export function parseLinkHeader(value) {
  const links = {};
  for (const part of String(value ?? "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

export async function paginate(client, endpoint, { limit = Number.POSITIVE_INFINITY, predicate = () => true } = {}) {
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(limit) && limit > 0))) {
    throw new Error("Pagination limit must be a positive integer");
  }
  const results = [];
  let url = endpoint.includes("?") ? `${endpoint}&per_page=100` : `${endpoint}?per_page=100`;
  const visited = new Set();
  const apiBase = new URL(`${client.apiUrl}/`);
  let pages = 0;
  while (url && results.length < limit) {
    const resolved = url.startsWith("/")
      ? new URL(`${client.apiUrl}${url}`)
      : new URL(url, apiBase);
    if (
      resolved.origin !== apiBase.origin ||
      !resolved.pathname.startsWith(apiBase.pathname)
    ) {
      throw new Error("GitHub pagination returned an untrusted next URL");
    }
    const normalized = resolved.toString();
    if (visited.has(normalized)) {
      throw new Error("GitHub pagination returned a repeated next URL");
    }
    if (pages >= MAX_PAGINATION_PAGES) {
      throw new Error(`GitHub pagination exceeded ${MAX_PAGINATION_PAGES} pages`);
    }
    visited.add(normalized);
    pages += 1;
    const response = await client.request("GET", url);
    if (!Array.isArray(response.data)) throw new Error(`Expected array from ${url}`);
    for (const item of response.data) {
      if (!predicate(item)) continue;
      results.push(item);
      if (results.length === limit) break;
    }
    const links = parseLinkHeader(response.headers.get("link"));
    url = links.next ?? "";
  }
  return results;
}

export async function listIssueCommentWindow(client, number, triggerCommentId, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("Recent issue comment limit must be between 1 and 100");
  }
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Issue number must be a positive integer");
  }
  if (!/^[1-9][0-9]*$/.test(String(triggerCommentId ?? ""))) {
    throw new Error("Triggering issue comment ID must be a positive integer");
  }

  // GitHub's per-issue comments endpoint is always chronological and does
  // not support sort or direction. Inspect the oldest page for delayed
  // events, then the final page and its predecessor for current events.
  const apiBase = new URL(`${client.apiUrl}/`);
  const firstUrl = client.repoPath(`/issues/${number}/comments?per_page=${limit}&page=1`);
  const seen = new Set();
  const comments = [];
  let requests = 0;

  const resolveTrustedPage = (url) => {
    const resolved = url.startsWith("/")
      ? new URL(`${client.apiUrl}${url}`)
      : new URL(url, apiBase);
    if (resolved.origin !== apiBase.origin || !resolved.pathname.startsWith(apiBase.pathname)) {
      throw new Error("GitHub issue-comment pagination returned an untrusted URL");
    }
    return resolved.toString();
  };

  const fetchPage = async (url) => {
    const resolved = resolveTrustedPage(url);
    if (seen.has(resolved)) throw new Error("GitHub issue-comment pagination returned a repeated URL");
    if (requests >= RECENT_ISSUE_COMMENT_PAGE_BUDGET) {
      throw new Error(`GitHub issue-comment pagination exceeded ${RECENT_ISSUE_COMMENT_PAGE_BUDGET} pages`);
    }
    seen.add(resolved);
    requests += 1;
    const response = await client.request("GET", url);
    if (!Array.isArray(response.data)) throw new Error(`Expected array from ${url}`);
    return { comments: response.data, links: parseLinkHeader(response.headers.get("link")), resolved };
  };

  const first = await fetchPage(firstUrl);
  comments.push(...first.comments);
  const firstHasTrigger = first.comments.some((comment) => String(comment?.id ?? "") === String(triggerCommentId));
  if (firstHasTrigger) {
    return { comments, truncatedBefore: false, truncatedAfter: Boolean(first.links.next) };
  }

  const last = first.links.last;
  if (!last || resolveTrustedPage(last) === first.resolved) {
    return { comments, truncatedBefore: false, truncatedAfter: false, triggerIncluded: false };
  }
  const finalPage = await fetchPage(last);
  const tailComments = [...finalPage.comments];
  let previous = finalPage.links.prev ?? "";
  if (previous && resolveTrustedPage(previous) !== first.resolved && requests < RECENT_ISSUE_COMMENT_PAGE_BUDGET) {
    const previousPage = await fetchPage(previous);
    tailComments.push(...previousPage.comments);
    previous = previousPage.links.prev ?? "";
  }
  const triggerIncluded = tailComments.some((comment) => String(comment?.id ?? "") === String(triggerCommentId));
  const tailTouchesFirst = Boolean(previous && resolveTrustedPage(previous) === first.resolved);
  return {
    comments: triggerIncluded
      ? tailTouchesFirst ? [...comments, ...tailComments] : tailComments
      : [...comments, ...tailComments],
    truncatedBefore: triggerIncluded && !tailTouchesFirst,
    truncatedAfter: false,
    triggerIncluded
  };
}
