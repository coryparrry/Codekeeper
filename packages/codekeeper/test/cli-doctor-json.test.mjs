import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { doctorRepository } from "../src/preflight.mjs";
import { result, temporaryDirectory, textSink } from "./helpers.mjs";

test("doctor JSON keeps an unavailable GitHub CLI as an aggregate check", async (t) => {
  const root = await temporaryDirectory(t);
  const output = textSink();
  const errorOutput = textSink();
  let resolverOptions;
  const runner = {
    async resolveTrustedCommands(options) {
      resolverOptions = options;
      return {
        async run(command, args) {
          if (command === "gh") return result("", { status: 127 });
          if (args[0] === "--version") return result("git version 2.0.0\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${root}\n`);
          if (args[0] === "rev-parse" && args[1] === "--is-bare-repository") return result("false\n");
          if (args[0] === "config" && args[1] === "--bool") return result("", { status: 1 });
          if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`.git/${args[2]}\n`);
          if (args[0] === "symbolic-ref") return result("main\n");
          if (args[0] === "remote") return result("https://github.com/acme/widget.git\n");
          if (args[0] === "status") return result("");
          if (args[0] === "config" && args[1] === "--get") return result(args[2] === "user.name" ? "Cory\n" : "cory@example.com\n");
          throw new Error(`Unexpected ${command} ${args.join(" ")}`);
        }
      };
    }
  };

  const status = await runCli({
    argv: ["doctor", "--json"],
    cwd: root,
    output,
    errorOutput,
    runner,
    doctor: (options) => doctorRepository({ ...options, nodeVersion: "22.0.0" })
  });

  assert.equal(status, 1);
  assert.deepEqual(resolverOptions, { cwd: root, allowMissingCommands: ["git", "gh"] });
  assert.equal(errorOutput.toString(), "");
  const report = JSON.parse(output.toString());
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("git")?.status, "pass");
  assert.equal(byId.get("gh")?.status, "fail");
  assert.equal(byId.get("auth")?.status, "skipped");
  assert.equal(byId.get("repository-identity")?.status, "skipped");
  assert.equal(report.mutationAllowed, false);
});
