# Dyad Zenith Electron Final Critique — 2026-08-11

## Verdict

The application is now a coherent Electron Forge/Vite source tree with explicit build, native-module, packaging, security and post-package contracts. The earlier “final” artifact was **not** sufficiently build-safe: it had removed a native module still required by production code, broadened Forge packaging, created a Vite/Forge externalization mismatch, contained a duplicate TypeScript function parameter, and reused an E2E fuse mode for unsigned production-like packages.

Those defects are corrected in this release candidate.

## Highest-value corrections

1. Restored `dyad-keychain-reader` and its macOS `node-gyp` rebuild lifecycle.
2. Restored a runtime-focused Forge package allowlist instead of shipping most of the source tree.
3. Re-aligned Vite externals with modules that Forge actually packages at runtime.
4. Fixed merge damage in `removeUnusedAppPackageFiles`.
5. Converted the remaining alias-based dynamic `require()` to a static Vite-owned import.
6. Separated production-equivalent unsigned packaging from E2E/debug fuse policy.
7. Reset the ad-hoc signature after fuse changes on unsigned Apple Silicon builds.
8. Added deterministic Node/Bun pins and lock/manifest validation.
9. Added a strict Electron build doctor and a post-package ASAR/native-resource verifier.
10. Added a native Linux/macOS/Windows CI packaging matrix.
11. Made release verifiers independent of the caller's current working directory.
12. Kept the one-agent/one-routing-policy architecture; no second autonomous Repo-Intel brain was reintroduced.

## Remaining material risk

Electron is still pinned to 40.0.0. This is intentionally not upgraded inside a sandbox that cannot perform a dependency install and native three-platform package test. Upgrade Electron only as a separately verified migration after this build matrix is green.

The only acceptable production decision is therefore:

- source/build architecture: **READY**;
- unsigned clean-machine package: **REQUIRES EXECUTION**;
- signed/notarized production distribution: **BLOCKED until platform CI and signing gates pass**.
