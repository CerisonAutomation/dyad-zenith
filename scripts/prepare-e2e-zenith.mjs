#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const nextTemplate = path.join(root, "nextjs-template");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

// Keep the preparation idempotent. An existing template checkout belongs to the
// caller and is never reset or deleted by the release command.
if (!fs.existsSync(nextTemplate)) {
  run("git", [
    "clone",
    "--depth",
    "1",
    "https://github.com/dyad-sh/nextjs-template.git",
    nextTemplate,
  ]);
}

// The fake LLM server is a separate package used by Playwright's webServer.
run("bun", ["install"], path.join(root, "testing", "fake-llm-server"));
run("bun", ["run", "build"], path.join(root, "testing", "fake-llm-server"));

// Match the version used by the canonical CI workflow so app-preview tests do
// not drift with the developer's global pnpm installation.
const pnpm = ["pnpm@10.33.2", "install", "--frozen-lockfile"];
run("bunx", pnpm, path.join(root, "scaffold"));
run("bunx", pnpm, nextTemplate);

console.log("ZENITH E2E PREP: PASS");
