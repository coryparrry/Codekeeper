export const API_VERSION = "2022-11-28";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_ATTEMPTS = 2;
export const MAX_RETRY_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 429]);
export const PULL_MUTATION_COMPENSATION = Symbol("pull-mutation-compensation");
export const ISSUE_MUTATION_INTERNAL = Symbol("issue-mutation-internal");

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function positiveFiniteNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function retryAttempts(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_RETRY_ATTEMPTS)
    : fallback;
}

function retryAfterMilliseconds(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}

function rateLimitResetMilliseconds(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000 - now()) : null;
}

function isRateLimited(response) {
  return response.status === 403 && (
    response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
  );
}

function isRetryableResponse(response) {
  return RETRYABLE_STATUS.has(response.status) || response.status >= 500 || isRateLimited(response);
}

function cappedDelay(milliseconds) {
  return Math.min(Math.max(0, milliseconds), MAX_RETRY_DELAY_MS);
}

function isTransientFailure(error, signal) {
  return signal.aborted || error instanceof TypeError;
}

export function awaitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => finish(reject, signal.reason ?? new Error("GitHub request aborted"));
    const finish = (settle, value) => {
      signal.removeEventListener("abort", abort);
      settle(value);
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

export function isRetrySafeMethod(method) {
  return ["GET", "HEAD"].includes(String(method).toUpperCase());
}

export function retryDelay(client, response, attempt) {
  const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"), client.now);
  if (retryAfter !== null) return cappedDelay(retryAfter);
  const reset = rateLimitResetMilliseconds(response.headers.get("x-ratelimit-reset"), client.now);
  if (reset !== null) return cappedDelay(reset);
  return cappedDelay(500 * 2 ** attempt);
}

export async function fetchWithRetry(client, url, options, { retries = client.retryAttempts, consume, retryPayload = () => false } = {}) {
  const retryBudget = retryAttempts(retries, client.retryAttempts);
  for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`GitHub request timed out after ${client.requestTimeoutMs}ms`)),
      client.requestTimeoutMs
    );
    let delay = null;
    try {
      const response = await client.fetch(url, { ...options, signal: controller.signal });
      if (isRetryableResponse(response) && attempt < retryBudget) {
        delay = client.retryDelay(response, attempt);
      } else {
        const value = await consume(response, controller.signal);
        if (!retryPayload(value) || attempt === retryBudget) return value;
        delay = client.retryDelay(response, attempt);
      }
    } catch (error) {
      if (!isTransientFailure(error, controller.signal) || attempt === retryBudget) throw error;
      delay = cappedDelay(500 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
    await client.sleep(delay);
  }
  throw new Error("GitHub retry budget exhausted");
}

export async function request(client, method, endpoint, { body, headers = {}, retries, retryPayload, guardToken } = {}) {
  const normalizedMethod = String(method).toUpperCase();
  if (!isRetrySafeMethod(normalizedMethod) &&
      guardToken !== PULL_MUTATION_COMPENSATION && guardToken !== ISSUE_MUTATION_INTERNAL) {
    await client.assertMutationCurrent();
  }
  const url = endpoint.startsWith("http") ? endpoint : `${client.apiUrl}${endpoint}`;
  const retryBudget = retries ?? (isRetrySafeMethod(normalizedMethod) ? client.retryAttempts : 0);
  let requestResult;
  try {
    requestResult = await client.fetchWithRetry(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${client.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "codekeeper",
        "Content-Type": "application/json",
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, {
      retries: retryBudget,
      retryPayload,
      consume: async (response, signal) => {
        const text = await awaitWithSignal(response.text(), signal);
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = text;
          }
        }
        return { response, text, payload };
      }
    });
  } catch (error) {
    if (!isRetrySafeMethod(normalizedMethod) && error && typeof error === "object") {
      error.githubMutationOutcome = "ambiguous";
    }
    throw error;
  }
  const { response, text, payload } = requestResult;
  if (!response.ok) {
    const message = typeof payload === "object" && payload?.message ? payload.message : text || response.statusText;
    const error = new Error(`GitHub ${method} ${endpoint} failed (${response.status}): ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  client.advancePullMutationState(normalizedMethod, endpoint, body);
  return { data: payload, headers: response.headers, status: response.status };
}
