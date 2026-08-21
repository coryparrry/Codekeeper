import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUTPUT_LIMIT = 1024 * 1024;
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message) {
  throw new Error(`Codekeeper release candidate verification failed: ${message}`);
}

export function commandEnvironment(root, overrides = {}) {
  const environment = {
    HOME: root,
    LANG: process.env.LANG ?? "C.UTF-8",
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(root, "empty-npmrc"),
    ...overrides,
  };
  if (process.platform === "win32" && process.env.SystemRoot) {
    environment.SystemRoot = process.env.SystemRoot;
  }
  return environment;
}

export async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let terminationRequested = false;
    let truncated = false;
    let timedOut = false;
    let timer;
    const terminateProcessTree = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      if (
        detached &&
        Number.isSafeInteger(child.pid) &&
        child.pid > 1 &&
        child.pid !== process.pid
      ) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") child.kill("SIGKILL");
        }
        return;
      }
      child.kill("SIGKILL");
    };
    const collect = (chunks) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) {
        truncated = true;
        terminateProcessTree();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateProcessTree();
      reject(error);
    });
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree();
    }, timeoutMs);
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        truncated,
      });
    });
  });
}

export function requireSuccess(result, label) {
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.truncated ||
    result.signal
  ) {
    const diagnostic = `${result.stdout}${result.stderr}`.trim().slice(-2000);
    fail(`${label} failed${diagnostic ? `: ${diagnostic}` : ""}`);
  }
}

function packageDocument(packageManifest, expected, registryUrl, tarballPath) {
  return {
    ...packageManifest,
    name: expected.name,
    version: expected.version,
    dist: {
      integrity: expected.integrity,
      shasum: expected.shasum,
      tarball: `${registryUrl}${tarballPath}`,
    },
  };
}

async function startCandidateRegistry({ bytes, expected, packageManifest }) {
  const requests = [];
  const tarballPath = `/${expected.name}/-/${expected.filename}`;
  const server = createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url, "http://127.0.0.1").pathname,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    requests.push(pathname);
    const registryUrl = `http://127.0.0.1:${server.address().port}`;
    if (request.method === "GET" && pathname === `/${expected.name}`) {
      const versionDocument = packageDocument(
        packageManifest,
        expected,
        registryUrl,
        tarballPath,
      );
      const body = Buffer.from(
        JSON.stringify({
          name: expected.name,
          "dist-tags": { latest: expected.version },
          versions: { [expected.version]: versionDocument },
        }),
      );
      response.writeHead(200, {
        "content-length": body.length,
        "content-type": "application/json",
      });
      response.end(body);
      return;
    }
    if (request.method === "GET" && pathname === tarballPath) {
      response.writeHead(200, {
        "content-length": bytes.length,
        "content-type": "application/octet-stream",
      });
      response.end(bytes);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    requests,
    registryUrl: `http://127.0.0.1:${server.address().port}/`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function runLiteralNpxLifecycle({
  bytes,
  expected,
  packageManifest,
  root,
}) {
  const repository = path.join(root, "no-origin-repository");
  await mkdir(repository, { recursive: true });
  const baseEnvironment = commandEnvironment(root);
  requireSuccess(
    await runCommand("git", ["init", "--initial-branch=main"], {
      cwd: repository,
      env: baseEnvironment,
    }),
    "fresh Git repository initialization",
  );
  await writeFile(
    path.join(repository, "README.md"),
    "# Candidate lifecycle fixture\n",
  );
  const identity = [
    "-c",
    "user.name=Codekeeper Candidate Gate",
    "-c",
    "user.email=codekeeper-candidate@example.invalid",
  ];
  requireSuccess(
    await runCommand("git", [...identity, "add", "README.md"], {
      cwd: repository,
      env: baseEnvironment,
    }),
    "fresh Git repository staging",
  );
  requireSuccess(
    await runCommand(
      "git",
      [
        ...identity,
        "commit",
        "-m",
        "test: initialize candidate lifecycle fixture",
      ],
      { cwd: repository, env: baseEnvironment },
    ),
    "fresh Git repository commit",
  );

  const registry = await startCandidateRegistry({
    bytes,
    expected,
    packageManifest,
  });
  let result;
  try {
    await writeFile(path.join(root, "empty-npmrc"), "");
    const environment = commandEnvironment(root, {
      NPM_CONFIG_REGISTRY: registry.registryUrl,
      npm_config_registry: registry.registryUrl,
      npm_config_prefer_online: "true",
      npm_config_yes: "true",
    });
    result = await runCommand(
      "npx",
      ["--yes", `${expected.name}@${expected.version}`, "init"],
      { cwd: repository, env: environment, timeoutMs: COMMAND_TIMEOUT_MS },
    );
  } finally {
    await registry.close();
  }
  if (result.status === 0 || result.timedOut || result.truncated || result.signal) {
    fail(
      "literal npx init did not produce a bounded observed repository-readiness stop",
    );
  }
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  if (
    !diagnostic.includes(
      "The checkout origin must be a credential-free GitHub.com repository URL.",
    ) ||
    !diagnostic.includes("Repository readiness checks failed")
  ) {
    fail(
      `literal npx init did not emit the expected repository-readiness diagnostics: ${diagnostic.trim().slice(-2000)}`,
    );
  }
  if (
    /integrity mismatch|invalid Codekeeper release|Could not resolve the Codekeeper release|Could not download the exact Codekeeper release|npm ERR!/i.test(
      diagnostic,
    )
  ) {
    fail("literal npx init reported an acquisition, receipt, or integrity failure");
  }
  const packageRequests = registry.requests.filter(
    (pathname) => pathname === `/${expected.name}`,
  );
  const tarballRequests = registry.requests.filter(
    (pathname) => pathname === `/${expected.name}/-/${expected.filename}`,
  );
  if (packageRequests.length === 0 || tarballRequests.length === 0) {
    fail("literal npx init did not acquire the exact candidate from the local registry");
  }
}
