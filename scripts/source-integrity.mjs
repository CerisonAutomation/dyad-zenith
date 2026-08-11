#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const failures = [];
const notes = [];
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md"];
const roots = ["src", "workers", "scripts", "tools/repo-intel"];
const ignoredDirs = new Set(["node_modules", ".git", ".vite", "out", "dist", "coverage"]);

function walk(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(child));
    else out.push(child);
  }
  return out;
}

function resolveLocal(fromFile, specifier) {
  const cleanSpecifier = specifier.replace(/[?#].*$/, "");
  const base = path.resolve(root, path.dirname(fromFile), cleanSpecifier);
  const candidates = [base, ...SOURCE_EXTS.map((ext) => base + ext)];
  for (const ext of SOURCE_EXTS) candidates.push(path.join(base, `index${ext}`));
  return candidates.some((candidate) => fs.existsSync(candidate));
}

const importRe = /^(?:\s*(?:import\s+(?:type\s+)?(?:[^"'\n]*?\s+from\s+)?|export\s+[^"'\n]*?\s+from\s+|}\s*from\s+|(?:const|let|var)\s+[^=\n]+?=\s*require\s*\(|require\s*\(|import\s*\())\s*["']([^"']+)["']/gm;
const isSyntheticOrTestSource = (file) =>
  /(?:^|\/)(?:__tests__|fixtures?|evals)(?:\/|$)/.test(file) ||
  /\.(?:test|spec)\.[^.]+$/.test(file) ||
  file.endsWith(".d.ts") ||
  file.startsWith("src/prompts/");
let localImports = 0;
for (const file of roots.flatMap(walk)) {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
  if (isSyntheticOrTestSource(file)) continue;
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(importRe)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    localImports++;
    if (!resolveLocal(file, specifier)) {
      failures.push(`unresolved local import: ${file} -> ${specifier}`);
    }
  }
}
notes.push(`local_imports=${localImports}`);

// Node can syntax-check release JavaScript without any installed dependencies.
let checkedJs = 0;
for (const file of ["scripts", "tools/repo-intel"].flatMap(walk)) {
  if (!/\.(?:js|mjs|cjs)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], {
    encoding: "utf8",
  });
  checkedJs++;
  if (result.status !== 0) failures.push(`JS syntax: ${file}: ${result.stderr || result.stdout}`);
}
notes.push(`js_syntax_files=${checkedJs}`);

for (const forbidden of ["userData", ".dyad-encryption-key", "node_modules", ".vite", "out"]) {
  if (fs.existsSync(path.join(root, forbidden))) failures.push(`distribution contains forbidden generated/runtime path: ${forbidden}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.packageManager !== "bun@1.3.14") failures.push("packageManager is not pinned to bun@1.3.14");
if (!packageJson.scripts?.["release:360"]) failures.push("release:360 script is missing");

if (failures.length) {
  console.error("SOURCE INTEGRITY: BLOCKED");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("SOURCE INTEGRITY: PASS");
for (const note of notes) console.log(` - ${note}`);
