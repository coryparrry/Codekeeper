import assert from "node:assert/strict";
import test from "node:test";
import {
  repairAppAuthority,
  reviewAppAuthority,
  reviewAppRegistrationUrl,
} from "../src/app-authority.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";

test("derives minimum review-only App authority", () => {
  assert.deepEqual(reviewAppAuthority(), {
    clientIdVariable: "RIVET_APP_CLIENT_ID",
    privateKeySecret: "RIVET_APP_PRIVATE_KEY",
    permissions: {
      contents: "read",
      metadata: "read",
      pullRequests: "write",
      issues: "write",
    },
    events: [],
  });
});

test("derives owner-authorized repair App authority", () => {
  assert.deepEqual(repairAppAuthority(), {
    clientIdVariable: "RIVET_APP_CLIENT_ID",
    privateKeySecret: "RIVET_APP_PRIVATE_KEY",
    permissions: {
      contents: "write",
      metadata: "read",
      pullRequests: "write",
    },
    events: [],
  });
});

test("builds a private webhook-free Rivet App registration URL", () => {
  const url = new URL(
    reviewAppRegistrationUrl({ repository: "Acme/Widget" }).split("#")[0],
  );
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/settings/apps/new");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    name: "Rivet Widget",
    description: "Rivet review automation for Acme/Widget",
    url: "https://github.com/Acme/Widget",
    public: "false",
    webhook_active: "false",
    contents: "read",
    pull_requests: "write",
    metadata: "read",
    issues: "write",
  });
});

test("does not request issue authority when triage is disabled", () => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  assert.deepEqual(reviewAppAuthority(configuration).permissions, {
    contents: "read",
    metadata: "read",
    pullRequests: "write",
  });
  const url = new URL(
    reviewAppRegistrationUrl({
      repository: "Acme/Widget",
      configuration,
    }).split("#")[0],
  );
  assert.equal(url.searchParams.has("issues"), false);
});

test("supports organization registration and rejects unsafe inputs", () => {
  const organization = new URL(
    reviewAppRegistrationUrl({
      repository: "Acme/Widget",
      ownerType: "Organization",
    }).split("#")[0],
  );
  assert.equal(organization.pathname, "/organizations/Acme/settings/apps/new");
  assert.throws(
    () => reviewAppRegistrationUrl({ repository: "not-a-repository" }),
    /owner\/repository/,
  );
  assert.throws(
    () => reviewAppRegistrationUrl({ repository: "../Widget" }),
    /owner\/repository/,
  );
  assert.throws(
    () =>
      reviewAppRegistrationUrl({
        repository: "Acme/Widget",
        ownerType: "Bot",
      }),
    /User or Organization/,
  );
});
