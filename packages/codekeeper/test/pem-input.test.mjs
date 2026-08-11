import test from "node:test";
import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { fstatSync } from "node:fs";
import path from "node:path";
import { createCommandRunner, openSafeStdinFile, STDIN_FILE_LIMIT_BYTES } from "../src/command-runner.mjs";
import { configureRepositorySettings, SECRET_UPLOAD_TIMEOUT_MS } from "../src/install.mjs";
import { createRecordingRunner, result, temporaryDirectory, textSink } from "./helpers.mjs";

const PRIVATE_KEY_BYTES = "private-key-byte-canary-never-render";
const PRIVATE_KEY_PATH_FRAGMENT = "private-key-path-canary";

function settingsPlan(root) {
  return {
    root,
    repository: "acme/widget",
    variables: [
      { name: "CODEKEEPER_ENABLED", value: "false" },
      { name: "CODEKEEPER_APP_CLIENT_ID", value: "Iv123456789012345678" }
    ],
    secrets: [
      { name: "OPENAI_API_KEY" },
      { name: "OPENAI_TRACE_API_KEY" },
      { name: "CODEKEEPER_APP_PRIVATE_KEY" }
    ]
  };
}

test("safe PEM input validates metadata without reading or retaining file bytes", () => {
  const operations = [];
  const fileOperations = {
    openSync(selectedPath, flags) {
      operations.push(["open", selectedPath, flags]);
      return 41;
    },
    fstatSync(descriptor) {
      operations.push(["fstat", descriptor]);
      return { isFile: () => true, size: 1024 };
    },
    closeSync(descriptor) {
      operations.push(["close", descriptor]);
    }
  };
  const selectedPath = `/private/tmp/${PRIVATE_KEY_PATH_FRAGMENT}.pem`;
  const input = openSafeStdinFile(selectedPath, { fileOperations });

  assert.equal(input.descriptor, 41);
  assert.equal(Object.hasOwn(input, "path"), false);
  assert.equal(Object.hasOwn(input, "contents"), false);
  assert.equal(operations[0][2], fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  assert.deepEqual(operations.slice(0, 2).map(([operation]) => operation), ["open", "fstat"]);
  input.close();
  input.close();
  assert.deepEqual(operations.map(([operation]) => operation), ["open", "fstat", "close"]);
});

test("safe PEM input requests nonblocking FIFO-safe open flags", () => {
  let flags = null;
  assert.throws(
    () => openSafeStdinFile(`/private/tmp/${PRIVATE_KEY_PATH_FRAGMENT}.fifo`, {
      fileOperations: {
        openSync(_selectedPath, requestedFlags) {
          flags = requestedFlags;
          return 47;
        },
        fstatSync() {
          return { isFile: () => false, size: 0 };
        },
        closeSync() {}
      }
    }),
    (error) => error.code === "SECRET_INPUT_FILE_INVALID"
  );
  if (fsConstants.O_NONBLOCK) assert.notEqual(flags & fsConstants.O_NONBLOCK, 0);
});

test("safe PEM input rejects unsafe paths and nonregular metadata with generic errors", () => {
  let opens = 0;
  const neverOpen = {
    openSync() {
      opens += 1;
      return 43;
    },
    fstatSync() {
      throw new Error("must not stat an invalid path");
    },
    closeSync() {}
  };
  for (const selectedPath of ["relative.pem", " /private/tmp/key.pem", "/private/tmp/key.pem ", "/private/tmp/key\n.pem"]) {
    assert.throws(
      () => openSafeStdinFile(selectedPath, { fileOperations: neverOpen }),
      (error) => error.code === "SECRET_INPUT_FILE_INVALID" && !error.message.includes(selectedPath)
    );
  }
  assert.equal(opens, 0);

  for (const metadata of [
    { isFile: () => false, size: 100 },
    { isFile: () => true, size: 0 },
    { isFile: () => true, size: STDIN_FILE_LIMIT_BYTES + 1 }
  ]) {
    let closes = 0;
    assert.throws(
      () => openSafeStdinFile(`/private/tmp/${PRIVATE_KEY_PATH_FRAGMENT}.pem`, {
        fileOperations: {
          openSync: () => 44,
          fstatSync: () => metadata,
          closeSync: () => { closes += 1; }
        }
      }),
      (error) => error.code === "SECRET_INPUT_FILE_INVALID"
        && !error.message.includes(PRIVATE_KEY_PATH_FRAGMENT)
        && !error.message.includes(PRIVATE_KEY_BYTES)
    );
    assert.equal(closes, 1);
  }
});

test("real missing, directory, symlink, empty, and oversized PEM inputs are rejected", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-pem-negative-");
  const missing = path.join(root, "missing.pem");
  const directory = path.join(root, "directory.pem");
  const empty = path.join(root, "empty.pem");
  const oversized = path.join(root, "oversized.pem");
  const regular = path.join(root, "regular.pem");
  const linked = path.join(root, "linked.pem");
  await mkdir(directory);
  await writeFile(empty, "");
  await writeFile(oversized, "x".repeat(STDIN_FILE_LIMIT_BYTES + 1));
  await writeFile(regular, `${PRIVATE_KEY_BYTES}\n`);
  if (process.platform !== "win32") await symlink(regular, linked);

  const paths = [missing, directory, empty, oversized];
  if (process.platform !== "win32") paths.push(linked);
  for (const selectedPath of paths) {
    assert.throws(
      () => openSafeStdinFile(selectedPath),
      (error) => error.code === "SECRET_INPUT_FILE_INVALID"
        && !error.message.includes(selectedPath)
        && !error.message.includes(PRIVATE_KEY_BYTES)
    );
  }

  const accepted = openSafeStdinFile(regular);
  assert.ok(Number.isInteger(accepted.descriptor) && accepted.descriptor >= 3);
  accepted.close();
});

test("invalid PEM input is rejected before any GitHub mutation", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-pem-preflight-");
  const selectedPath = path.join(root, `${PRIVATE_KEY_PATH_FRAGMENT}.pem`);
  const output = textSink();
  const runner = createRecordingRunner(() => {
    throw new Error("no external command may run after invalid PEM selection");
  });

  await assert.rejects(
    configureRepositorySettings(settingsPlan(root), {
      runner,
      output,
      appPrivateKeyPath: selectedPath,
      resumeCommand: "safe resume"
    }),
    (error) => error.code === "SECRET_INPUT_FILE_INVALID"
  );
  assert.deepEqual(runner.calls, []);
  assert.doesNotMatch(output.toString(), new RegExp(PRIVATE_KEY_PATH_FRAGMENT));
});

test("App PEM uses fd-only child input, closes on failure, and leaks no path or bytes", async () => {
  const selectedPath = `/private/tmp/${PRIVATE_KEY_PATH_FRAGMENT}.pem`;
  let closed = 0;
  const runner = createRecordingRunner((call) => {
    if (call.args.includes("CODEKEEPER_APP_PRIVATE_KEY")) throw new Error("simulated child start failure");
    return result();
  });
  const output = textSink();

  await assert.rejects(
    configureRepositorySettings(settingsPlan("/tmp/widget"), {
      runner,
      output,
      appPrivateKeyPath: selectedPath,
      openInputFile(pathArgument) {
        assert.equal(pathArgument, selectedPath);
        return { descriptor: 45, close() { closed += 1; } };
      },
      resumeCommand: "safe resume"
    }),
    (error) => error.code === "EXTERNAL_MUTATION_FAILED" && error.resume === "safe resume"
  );

  const appCall = runner.calls.find((call) => call.args.includes("CODEKEEPER_APP_PRIVATE_KEY"));
  assert.deepEqual(appCall.options, {
    cwd: "/tmp/widget",
    stdio: "ignore",
    stdinFd: 45,
    timeoutMs: SECRET_UPLOAD_TIMEOUT_MS
  });
  assert.equal(closed, 1);
  const observable = `${JSON.stringify(runner.calls)}\n${output.toString()}`;
  assert.doesNotMatch(observable, new RegExp(PRIVATE_KEY_PATH_FRAGMENT));
  assert.doesNotMatch(observable, new RegExp(PRIVATE_KEY_BYTES));
  assert.ok(runner.calls.every((call) => !Object.hasOwn(call.options, "env")));
});

test("a real PEM file is supplied to GitHub CLI stdin and its descriptor closes after success and failure", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-pem-child-");
  const selectedPath = path.join(root, "real-child-input.pem");
  const bin = path.join(root, "bin");
  const gh = path.join(bin, "gh");
  await writeFile(selectedPath, `${PRIVATE_KEY_BYTES}\n`);
  await mkdir(bin);
  await writeFile(gh, [
    "#!/usr/bin/env node",
    "const fs = require(\"node:fs\");",
    "if (process.argv[2] !== \"secret\") process.exit(0);",
    "const chunks = [];",
    "process.stdin.on(\"data\", (chunk) => chunks.push(chunk));",
    "process.stdin.on(\"end\", () => {",
    `  fs.writeFileSync(${JSON.stringify(path.join(root, "captured.pem"))}, Buffer.concat(chunks));`,
    `  process.exit(fs.existsSync(${JSON.stringify(path.join(root, "fail-app-secret"))}) ? 23 : 0);`,
    "});",
    ""
  ].join("\n"));
  await chmod(gh, 0o700);
  const runner = createCommandRunner({
    environment: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root, LANG: "C" }
  });
  const plan = { ...settingsPlan(root), secrets: [{ name: "CODEKEEPER_APP_PRIVATE_KEY" }] };
  const capturedPath = path.join(root, "captured.pem");

  for (const [label, fail] of [["success", false], ["failure", true]]) {
    if (fail) await writeFile(path.join(root, "fail-app-secret"), "1");
    await writeFile(capturedPath, "");
    let descriptor = null;
    const configure = configureRepositorySettings(plan, {
      runner,
      output: textSink(),
      appPrivateKeyPath: selectedPath,
      openInputFile(pathArgument) {
        const input = openSafeStdinFile(pathArgument);
        descriptor = input.descriptor;
        return input;
      },
      resumeCommand: "safe resume"
    });
    if (fail) {
      await assert.rejects(configure, (error) => error.code === "EXTERNAL_MUTATION_FAILED");
    } else {
      await configure;
    }
    assert.equal((await readFile(capturedPath, "utf8")), `${PRIVATE_KEY_BYTES}\n`, `${label} child stdin`);
    assert.throws(() => fstatSync(descriptor), { code: "EBADF" }, `${label} input descriptor must close`);
  }
});
