#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const out = path.join(root, "out");
const failures = [];
const notes = [];
const assert = (ok, message) => { if (!ok) failures.push(message); };

if (!fs.existsSync(out)) {
  console.error("ELECTRON PACKAGE VERIFY: BLOCKED\n - out/ does not exist; run bun run package:unsigned first");
  process.exit(1);
}

const candidates = fs.readdirSync(out, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^dyad-(?:darwin|linux|win32)-/.test(e.name))
  .map((e) => path.join(out, e.name));
assert(candidates.length === 1, `expected exactly one packaged app directory in out/, found ${candidates.length}`);
const appDir = candidates[0];

if (appDir) {
  const platform = path.basename(appDir).split("-")[1];
  let resources;
  let executable;
  if (platform === "darwin") {
    const appBundle = path.join(appDir, "dyad.app");
    assert(fs.existsSync(appBundle), "macOS .app bundle is missing");
    resources = path.join(appBundle, "Contents", "Resources");
    executable = path.join(appBundle, "Contents", "MacOS", "dyad");
  } else if (platform === "win32") {
    resources = path.join(appDir, "resources");
    executable = path.join(appDir, "dyad.exe");
  } else {
    resources = path.join(appDir, "resources");
    executable = path.join(appDir, "dyad");
  }

  assert(fs.existsSync(executable), `packaged Electron executable is missing: ${executable}`);
  assert(fs.existsSync(resources), `resources directory is missing: ${resources}`);
  const asar = path.join(resources, "app.asar");
  assert(fs.existsSync(asar), "resources/app.asar is missing");
  if (fs.existsSync(asar)) {
    const asarCli = path.join(root, "node_modules", "@electron", "asar", "bin", "asar.js");
    assert(fs.existsSync(asarCli), "@electron/asar CLI is unavailable for package verification");
    if (fs.existsSync(asarCli)) {
      const listed = spawnSync(process.execPath, [asarCli, "list", asar], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      assert(listed.status === 0, `unable to list app.asar: ${listed.stderr || listed.stdout}`);
      if (listed.status === 0) {
        const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
        const hasPrefix = (prefix) => entries.some((e) => e === prefix || e.startsWith(prefix + "/"));
        for (const required of ["/.vite/build", "/drizzle", "/scaffold", "/worker", "/assets/icon"]) {
          assert(hasPrefix(required), `app.asar missing required runtime path ${required}`);
        }
        for (const forbidden of ["/src", "/docs", "/e2e-tests", "/testing", "/tools/repo-intel", "/userData", "/.git"]) {
          assert(!hasPrefix(forbidden), `app.asar contains source/dev-only path ${forbidden}`);
        }
        assert(entries.includes("/.vite/build/main.js"), "app.asar missing Electron main entry /.vite/build/main.js");
        assert(entries.includes("/.vite/build/preload.js"), "app.asar missing preload entry /.vite/build/preload.js");
        assert(entries.includes("/assets/icon/logo.png"), "app.asar missing runtime icon /assets/icon/logo.png");
        notes.push(`asar_entries=${entries.length}`);
      }
    }
  }

  const unpacked = path.join(resources, "app.asar.unpacked");
  assert(fs.existsSync(unpacked), "app.asar.unpacked is missing native runtime files");
  const nativeFiles = fs.existsSync(unpacked) ? walk(unpacked).filter((p) => p.endsWith(".node")) : [];
  for (const required of ["better-sqlite3", "node-pty", "mustardscript"]) {
    assert(nativeFiles.some((p) => p.includes(required)), `native runtime binary missing for ${required}`);
  }
  if (platform === "darwin") {
    assert(nativeFiles.some((p) => p.includes("dyad-keychain-reader") && p.endsWith("keychain_reader.node")), "macOS keychain reader native binary is missing");
  }

  assert(fs.existsSync(path.join(resources, "git")), "Dugite Git extraResource is missing");
  assert(fs.existsSync(path.join(resources, "@vscode")), "@vscode extraResource is missing");
  assert(!fs.existsSync(path.join(resources, "userData")), "userData leaked into packaged resources");
  notes.push(`package_dir=${path.relative(root, appDir)}`);
  notes.push(`native_binaries=${nativeFiles.length}`);
}

function walk(dir) {
  const result = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...walk(p));
    else result.push(p);
  }
  return result;
}

if (failures.length) {
  console.error("ELECTRON PACKAGE VERIFY: BLOCKED");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("ELECTRON PACKAGE VERIFY: PASS");
for (const note of notes) console.log(` - ${note}`);
