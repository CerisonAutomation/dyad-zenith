#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const nodeRequire = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const installed = args.has("--installed");
const staticOnly = args.has("--static");
const failures = [];
const notes = [];

const file = (p) => path.join(root, p);
const exists = (p) => fs.existsSync(file(p));
const read = (p) => fs.readFileSync(file(p), "utf8");
const assert = (ok, message) => { if (!ok) failures.push(message); };

function parseVersion(raw) {
  const match = String(raw).trim().match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}
function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

const pkg = JSON.parse(read("package.json"));
const forge = read("forge.config.ts");
const viteMain = read("vite.main.config.mts");
const lock = read("bun.lock");
const mainSource = read("src/main.ts");
const preloadSource = read("src/preload.ts");
const windowSecurity = read("src/main/window_security.ts");
const packagingCleanup = read("src/lib/packaging_cleanup.ts");

assert(pkg.main === ".vite/build/main.js", "package.json main must target .vite/build/main.js");
assert(pkg.packageManager === "bun@1.3.14", "packageManager must be pinned to bun@1.3.14");
assert(pkg.engines?.node === ">=24 <26", "Node engine must remain >=24 <26");
assert(exists(".nvmrc") && read(".nvmrc").trim() === "24.13.1", "pinned Node version file must be 24.13.1");
assert(exists(".bun-version") && read(".bun-version").trim() === "1.3.14", "pinned Bun version file must be 1.3.14");
assert(pkg.engines?.bun === ">=1.3.14 <2", "Bun engine must remain >=1.3.14 <2");
assert(pkg.devDependencies?.["@electron/asar"], "direct @electron/asar dev dependency is required for deterministic package inspection");
assert(pkg.optionalDependencies?.["dyad-keychain-reader"] === "file:native/keychain-reader", "macOS keychain reader optional dependency is missing");
for (const dep of ["electron", "dugite", "better-sqlite3", "node-pty"]) {
  assert(pkg.trustedDependencies?.includes(dep), `required Bun trusted dependency missing: ${dep}`);
}
assert(pkg.scripts?.["package:unsigned"]?.includes("DYAD_UNSIGNED_BUILD=true") && !pkg.scripts?.["package:unsigned"]?.includes("E2E_TEST_BUILD=true"), "unsigned package must not enable E2E_TEST_BUILD");
assert(pkg.scripts?.["package:e2e"]?.includes("E2E_TEST_BUILD=true"), "E2E package must explicitly enable E2E_TEST_BUILD");
for (const script of ["rebuild:keychain-reader", "package", "package:unsigned", "build:electron", "doctor:electron", "verify:electron-package", "release:zenith"]) {
  assert(Boolean(pkg.scripts?.[script]), `missing build script: ${script}`);
}
for (const p of [
  "forge.config.ts",
  "vite.main.config.mts",
  "vite.preload.config.mts",
  "vite.renderer.config.mts",
  "src/main.ts",
  "src/preload.ts",
  "workers/code_explorer/code_explorer_worker.ts",
  "workers/supabase_dependency_analysis/supabase_dependency_analysis_worker.ts",
  "src/ipc/utils/sandbox/sandbox_worker.ts",
  "native/keychain-reader/package.json",
  "native/keychain-reader/index.js",
  "native/keychain-reader/binding.gyp",
  "native/keychain-reader/src/keychain_reader.c",
  "scripts/rebuild-keychain-reader.mjs",
  "assets/icon/logo.png",
  "assets/icon/logo.ico",
  "drizzle",
  "scaffold",
  "worker",
]) assert(exists(p), `required Electron build input missing: ${p}`);

assert(lock.includes('"dyad-keychain-reader": "file:native/keychain-reader"'), "bun.lock workspace is missing keychain reader optional dependency");
assert(lock.includes('"dyad-keychain-reader": ["dyad-keychain-reader@file:native/keychain-reader"'), "bun.lock package entry is missing keychain reader");
assert(forge.includes('"dyad-keychain-reader"'), "Forge native rebuild configuration omits keychain reader");
assert(forge.includes("AutoUnpackNativesPlugin"), "Forge AutoUnpackNativesPlugin is missing");
assert(forge.includes("EnableEmbeddedAsarIntegrityValidation"), "ASAR integrity fuse is missing");
assert(forge.includes("OnlyLoadAppFromAsar"), "OnlyLoadAppFromAsar fuse is missing");
assert(forge.includes('if (file.startsWith("/.vite")) return false;'), "Forge ignore filter does not preserve Vite output");
assert(forge.includes('if (file.startsWith("/drizzle")) return false;'), "Forge ignore filter does not preserve migrations");
assert(forge.includes('if (file.startsWith("/scaffold")) return false;'), "Forge ignore filter does not preserve scaffold");
assert(forge.includes('if (file.startsWith("/assets/icon")) return false;'), "Forge ignore filter does not preserve runtime window icon");
assert(forge.includes("concurrent: 2"), "Forge Vite build concurrency must be bounded to 2");
assert(forge.includes("DYAD_UNSIGNED_BUILD") && forge.includes("skipMacSigning"), "Forge unsigned production packaging flag is missing");
assert(forge.includes("[FuseV1Options.EnableNodeCliInspectArguments]: isEndToEndTestBuild"), "CLI inspect fuse must be restricted to E2E builds");
assert(forge.includes("resetAdHocDarwinSignature") && forge.includes("skipMacSigning && process.platform === \"darwin\""), "Apple Silicon unsigned fuse signature reset is missing");
assert(!/removeUnusedAppPackageFiles\(\s*appPath:\s*string,\s*appPath:/m.test(packagingCleanup), "packaging cleanup contains a duplicate appPath parameter");
assert(mainSource.includes("nodeIntegration: false"), "main BrowserWindow must disable Node integration");
assert(mainSource.includes("contextIsolation: true"), "main BrowserWindow must enable context isolation");
assert(mainSource.includes("sandbox: true"), "main BrowserWindow must explicitly enable sandbox");
assert(mainSource.includes("app.enableSandbox()"), "Electron global sandbox is not enabled");
assert(mainSource.includes('webContents.on("will-navigate", rejectUnexpectedNavigation)'), "main window navigation guard is missing");
assert(mainSource.includes("setWindowOpenHandler"), "window.open policy is missing");
assert(preloadSource.includes("VALID_INVOKE_CHANNELS") && preloadSource.includes("VALID_RECEIVE_CHANNELS"), "preload IPC channel allowlist is missing");
for (const invariant of ["sandbox: true", "contextIsolation: true", "nodeIntegration: false", "webSecurity: true", "webviewTag: false"]) {
  assert(windowSecurity.includes(invariant), `preview window security invariant missing: ${invariant}`);
}
assert(!forge.includes('const excludedRoots = ['), "broad include packaging filter from old RC is still present");
for (const dep of ["better-sqlite3", "dyad-keychain-reader", "node-pty", "mustardscript", "pg"]) {
  assert(viteMain.includes(`"${dep}"`), `main Vite config must externalize runtime/native module ${dep}`);
}
for (const forbidden of ["@ai-sdk/openai", "google-auth-library", "@babel/parser", "recast"]) {
  assert(!viteMain.includes(`"${forbidden}"`), `main Vite config unnecessarily externalizes bundled dependency ${forbidden}`);
}

if (!staticOnly) {
  const nodeVersion = parseVersion(process.versions.node);
  assert(nodeVersion && nodeVersion[0] >= 24 && nodeVersion[0] < 26, `Node ${process.versions.node} does not satisfy >=24 <26`);
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.error) failures.push(`Bun is unavailable: ${bun.error.message}`);
  else if (bun.status !== 0) failures.push(`bun --version failed: ${bun.stderr || bun.stdout}`);
  else {
    const bunVersion = parseVersion(bun.stdout);
    assert(bunVersion && gte(bunVersion, [1, 3, 14]), `Bun ${bun.stdout.trim()} is older than required 1.3.14`);
    notes.push(`bun=${bun.stdout.trim()}`);
  }
  notes.push(`node=${process.versions.node}`);
}

if (installed) {
  const requiredModules = [
    "electron/package.json",
    "@electron-forge/cli/package.json",
    "@electron-forge/plugin-vite/package.json",
    "better-sqlite3/package.json",
    "node-pty/package.json",
    "mustardscript/package.json",
    "dugite/package.json",
    "@vscode/ripgrep/package.json",
  ];
  for (const mod of requiredModules) {
    try { requireResolve(mod); } catch { failures.push(`installed dependency missing: ${mod}`); }
  }
  assert(exists("node_modules/dugite/git"), "Dugite Git runtime was not installed; Bun lifecycle trust/config is incomplete");
  if (process.platform === "darwin") {
    assert(exists("node_modules/dyad-keychain-reader/package.json"), "macOS keychain reader was not installed");
  }
}

function requireResolve(specifier) {
  return nodeRequire.resolve(specifier, { paths: [root] });
}

if (failures.length) {
  console.error("ELECTRON BUILD DOCTOR: BLOCKED");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("ELECTRON BUILD DOCTOR: PASS");
for (const note of notes) console.log(` - ${note}`);
