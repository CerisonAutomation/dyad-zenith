# Dyad Zenith Electron Build Hardening — 2026-08-11

## Decision

**Source/build contract: READY FOR CLEAN-MACHINE BUILD VERIFICATION.**

**Production release: BLOCKED until the clean-machine Bun/Electron matrix is green.**

This distinction is intentional. The current audit environment has Node 22 and no Bun or npm-registry connectivity, so it cannot truthfully execute the project's required Node 24 + Bun 1.3.14 dependency install and Forge package step.

## Critical build defects found and fixed

1. **Missing macOS native keychain module**
   - Production code still loads `dyad-keychain-reader`, but the previous consolidated archive had removed its local package and rebuild contract.
   - Restored `native/keychain-reader/**`, the optional dependency, and the rebuild script.
   - Forge now rebuilds/unpacks the native module on macOS.

2. **Over-broad Forge packaging**
   - The previous `ignore()` logic could copy source/tests/docs/tooling into the packaged application.
   - Restored a runtime allowlist for Vite output, migrations, scaffold, worker assets, required runtime modules, and the runtime icon.

3. **Vite/Forge externalization mismatch**
   - The previous main Vite config externalized ordinary JavaScript libraries that the Forge package filter would not preserve.
   - Ordinary JS is bundled again; only native/runtime modules are externalized.

4. **Broken packaging-cleanup signature**
   - `removeUnusedAppPackageFiles` contained the `appPath` parameter twice.
   - Restored the intended three-argument function contract.

5. **Alias-based runtime `require()`**
   - `auto_trigger.ts` used `require("@/lib/log_store")`, which could survive bundling as a runtime alias resolution problem.
   - Converted to a static import so Vite owns the dependency edge.

6. **Unsigned build was using E2E fuse policy**
   - The previous unsigned build set `E2E_TEST_BUILD=true`, which also enables CLI inspection for E2E.
   - Added `DYAD_UNSIGNED_BUILD=true`; unsigned production-equivalent packages now retain production fuses.
   - E2E package behavior remains isolated under `package:e2e`.

7. **Unsigned Apple Silicon fuse mutation**
   - Added `resetAdHocDarwinSignature` for unsigned/E2E Apple Silicon builds so a fuse-mutated binary can launch without release signing credentials.

8. **Runtime icon packaging**
   - `BrowserWindow` resolves `assets/icon/logo.png` via `app.getAppPath()`.
   - Forge now explicitly preserves `assets/icon`, and the post-package verifier requires the icon in ASAR.

9. **Implicit renderer sandboxing**
   - The app already calls `app.enableSandbox()` globally.
   - The primary BrowserWindow now also declares `sandbox: true` explicitly for local readability and defense in depth.

10. **Non-deterministic package inspection dependency**
    - `@electron/asar` was only transitive while the release verifier uses its CLI.
    - It is now a direct dev dependency and represented in `bun.lock`.

## Reproducible toolchain

- Node: **24.13.1** (`.nvmrc`)
- Bun: **1.3.14** (`.bun-version`, `packageManager`)
- Electron: **40.0.0** (existing project pin; not silently upgraded without a green compatibility matrix)
- Electron Forge: **7.11.2**

`package.json` and the root workspace in `bun.lock` have exact dependency-spec parity in this artifact.

## Build commands

### Clean machine

```bash
bun ci
bun run build
```

`bun run build` executes:

1. installed dependency/toolchain doctor;
2. Zenith architecture/security policy gate;
3. unsigned production-equivalent Electron Forge package;
4. packaged-ASAR/native-resource verification.

### Full release-quality verification

```bash
bun ci
bun run release:zenith
```

This additionally runs the project's complete typecheck and test suite before packaging.

### E2E-specific package

```bash
bun run package:e2e
```

Only this path enables the E2E inspect fuse behavior.

## Package verification

`scripts/verify-electron-package.mjs` rejects a package unless it contains:

- Electron executable / `.app`;
- `resources/app.asar`;
- main and preload Vite entries;
- migrations (`drizzle`);
- application scaffold;
- worker runtime;
- runtime icon;
- unpacked native modules (`better-sqlite3`, `node-pty`, `mustardscript`);
- `dyad-keychain-reader` on macOS;
- packaged Dugite Git;
- packaged VS Code/Ripgrep resources.

It also rejects packaged source/dev state including `src`, `docs`, tests, Repo-Intel source, `userData`, and `.git`.

## Electron security invariants

The build doctor verifies source-level invariants for:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- explicit `sandbox: true` plus global `app.enableSandbox()`;
- navigation interception;
- window-open policy;
- preload IPC channel allowlists;
- sandboxed preview windows;
- `webSecurity: true`;
- `webviewTag: false`;
- RunAsNode fuse disabled;
- NODE_OPTIONS fuse disabled;
- CLI inspect fuse restricted to E2E;
- embedded ASAR integrity enabled;
- only-load-from-ASAR enabled.

## CI build proof

`.github/workflows/zenith-electron-build.yml` runs a native three-OS matrix:

- Ubuntu 22.04
- macOS 14
- Windows Server 2022

with Node 24.13.1 and Bun 1.3.14. Each job performs:

`bun ci → doctor → policy → typecheck → tests → Forge package → package verifier`

The matrix publishes the packaged application as a short-lived CI artifact.

## Checks completed in this audit environment

- Electron static build doctor: **PASS**
- Zenith policy gate: **PASS**
- dependency-free utility tests: **14/14 PASS**
- TypeScript/TSX parser sweep: **0 syntax errors**
- production local-import graph: **0 missing local imports**
- Repo-Intel runtime risk scan: **0 findings**
- `package.json` / `bun.lock` direct dependency parity: **PASS**
- JS/MJS syntax sweep: **PASS**
- GitHub workflow YAML parsing: **PASS**
- common live-secret prefix scan: **PASS**
- dangerous Electron webPreference scan: **PASS**
- strict doctor on this container: **correctly BLOCKED** (Node 22, Bun unavailable)
- package verifier before Forge output: **correctly BLOCKED**

## Remaining production blockers

1. A real `bun ci` has not executed in this sandbox because Bun/package-registry access is unavailable.
2. The full TypeScript semantic checks and full Vitest suite require installed dependencies.
3. Electron Forge has not produced the native platform packages in this sandbox.
4. The post-package verifier therefore has not inspected a real ASAR/native output here.
5. Electron 40.0.0 is older than the current stable Electron line. Do not perform an unverified major-version jump inside this hardening patch; schedule the Electron upgrade as a separately tested dependency migration once the three-OS package matrix is green.
6. Signing/notarization is intentionally outside `package:unsigned`; production distribution still requires the normal Apple/Windows signing secrets and release pipeline.

## Release stop condition

Do **not** call this build production-verified unless all three OS jobs are green and `bun run verify:electron-package` succeeds for each produced package.

## Final freeze replay

The release was replayed after the last hardening change from both the repository root and an unrelated working directory.

Final static evidence:

- Electron static build doctor: **PASS**
- Zenith architecture/policy verifier: **PASS**
- Policy digest: `12387c0708bdb5fc4af111b0b03449eb22033c29540528c53946af0709eb3c22`
- Model-visible concrete tools: **50**
- Dependency-free utility tests: **14/14 PASS**
- TypeScript-family parser sweep: **1,781 files / 0 syntax errors**
- Production TypeScript-family local-import sweep: **1,189 files / 0 missing local imports**
- Repo-Intel runtime risk scan: **0 findings**
- `package.json` / root `bun.lock` dependency-spec parity: **0 mismatches**
- Runtime source live-secret prefix scan: **0 findings**
- GitHub workflow YAML parse: **PASS**
- Release JS/MJS syntax sweep: **PASS**
- Forbidden generated/runtime directories in source distribution: **0**
- Release verifiers invoked outside repository cwd: **PASS**

Fail-closed evidence in this audit container:

- Strict Electron doctor: **BLOCKED as designed** because this container is Node 22.16.0 and has no Bun executable; the project requires Node >=24 <26 and Bun >=1.3.14.
- Post-package verifier before Forge output: **BLOCKED as designed** because `out/` does not exist.

Those blocks are evidence that the release scripts do not convert missing prerequisites or missing package output into a false success.

## Buildability verdict

**Electron source/build contract: BUILDABLE BY DESIGN AND READY FOR CLEAN-MACHINE EXECUTION.**

**Production package proof: NOT YET VERIFIED IN THIS SANDBOX.**

A production-ready claim requires the native CI matrix or an equivalent clean machine to complete:

```bash
bun ci
bun run release:zenith
```

and for `verify:electron-package` to pass on Linux, macOS and Windows package output. This distinction is a release invariant, not a documentation caveat.
