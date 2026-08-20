import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNodeVersion,
  assertNoInstallationFiles,
  assertNoSetupBranch,
  discoverRepositoryValidationCommand,
  doctorRepository,
  inspectInstallationFiles,
  inspectRepository,
  parseGitHubRemote,
  parseReleaseManifest,
  parseRemoteBranchSha,
} from "../src/preflight.mjs";
import {
  assertNoInstallationFiles as assertCollisionInstallationFiles,
  assertNoSetupBranch as assertCollisionSetupBranch,
} from "../src/preflight/collisions.mjs";
import { doctorRepository as doctorFromDoctorModule } from "../src/preflight/doctor.mjs";
import { assertNodeVersion as assertEnvironmentNodeVersion } from "../src/preflight/environment.mjs";
import {
  discoverRepositoryValidationCommand as discoverInstallationValidationCommand,
  inspectInstallationFiles as inspectInstallationFromInstallation,
  parseReleaseManifest as parseInstallationReleaseManifest,
} from "../src/preflight/installation.mjs";
import {
  inspectRepository as inspectRepositoryFromIndex,
} from "../src/preflight/index.mjs";
import {
  parseGitHubRemote as parseRepositoryGitHubRemote,
  parseRemoteBranchSha as parseRepositoryRemoteBranchSha,
} from "../src/preflight/repository.mjs";
import {
  assertInstallerCode,
  HEAD_SHA,
} from "./helpers.mjs";

test("preflight facade re-exports extracted environment and repository helpers", () => {
  assert.equal(assertNodeVersion, assertEnvironmentNodeVersion);
  assert.equal(parseGitHubRemote, parseRepositoryGitHubRemote);
  assert.equal(parseRemoteBranchSha, parseRepositoryRemoteBranchSha);
});

test("preflight facade re-exports extracted installation, collision, and doctor helpers", () => {
  assert.equal(parseReleaseManifest, parseInstallationReleaseManifest);
  assert.equal(discoverRepositoryValidationCommand, discoverInstallationValidationCommand);
  assert.equal(inspectInstallationFiles, inspectInstallationFromInstallation);
  assert.equal(assertNoInstallationFiles, assertCollisionInstallationFiles);
  assert.equal(assertNoSetupBranch, assertCollisionSetupBranch);
  assert.equal(doctorRepository, doctorFromDoctorModule);
  assert.equal(inspectRepository, inspectRepositoryFromIndex);
});

test("extracted environment helper keeps Node 22 as the minimum runtime", () => {
  assert.doesNotThrow(() => assertEnvironmentNodeVersion("22.0.0"));
  assert.doesNotThrow(() => assertEnvironmentNodeVersion("26.1.0"));
  assert.throws(() => assertEnvironmentNodeVersion("21.9.0"), assertInstallerCode(assert, "UNSUPPORTED_NODE"));
  assert.throws(() => assertEnvironmentNodeVersion("not-a-version"), assertInstallerCode(assert, "UNSUPPORTED_NODE"));
});

test("extracted origin parser accepts only credential-free GitHub.com HTTPS and SSH", () => {
  assert.deepEqual(parseRepositoryGitHubRemote("https://github.com/Acme/Widget.git"), {
    host: "github.com",
    repository: "Acme/Widget",
    protocol: "https"
  });
  assert.deepEqual(parseRepositoryGitHubRemote("git@github.com:acme/widget.git"), {
    host: "github.com",
    repository: "acme/widget",
    protocol: "ssh"
  });
  assert.deepEqual(parseRepositoryGitHubRemote("ssh://git@github.com/acme/widget.git"), {
    host: "github.com",
    repository: "acme/widget",
    protocol: "ssh"
  });
  for (const remote of [
    "https://github.example.com/acme/widget.git",
    "https://token@github.com/acme/widget.git",
    "https://github.com/acme/widget.git?token=secret",
    "ssh://root@github.com/acme/widget.git",
    "git://github.com/acme/widget.git",
    "git@git.example.com:acme/widget.git",
    "https://github.com/acme/nested/widget.git",
    ""
  ]) {
    assert.throws(() => parseRepositoryGitHubRemote(remote), assertInstallerCode(assert, "UNSUPPORTED_ORIGIN"), remote);
  }
});

test("extracted remote-branch parser requires exactly one GitHub.com default-branch tip", () => {
  assert.equal(
    parseRepositoryRemoteBranchSha(`${HEAD_SHA}\trefs/heads/main\n`, "main"),
    HEAD_SHA,
  );
  assert.throws(
    () => parseRepositoryRemoteBranchSha("", "main"),
    assertInstallerCode(assert, "REMOTE_HEAD_INVALID"),
  );
  assert.throws(
    () => parseRepositoryRemoteBranchSha(`${HEAD_SHA}\trefs/heads/main\n${HEAD_SHA}\trefs/heads/main\n`, "main"),
    assertInstallerCode(assert, "REMOTE_HEAD_INVALID"),
  );
  assert.throws(
    () => parseRepositoryRemoteBranchSha(`${HEAD_SHA}\trefs/heads/develop\n`, "main"),
    assertInstallerCode(assert, "REMOTE_HEAD_INVALID"),
  );
  assert.throws(
    () => parseRepositoryRemoteBranchSha(`not-a-sha\trefs/heads/main\n`, "main"),
    assertInstallerCode(assert, "REMOTE_HEAD_INVALID"),
  );
});
