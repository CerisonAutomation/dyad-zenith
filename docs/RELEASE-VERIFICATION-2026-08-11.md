# Dyad Zenith Final — Release Verification

Date: 2026-08-11
Status: **Release Candidate — machine-level Bun gates blocked in this audit environment**

## Canonical architecture

This release intentionally collapses the experimental stack into one product runtime:

- **One runtime agent:** Dyad `local-agent`.
- **One default model policy:** `Zenith Auto` (`auto/auto`).
- **Default/free-first routing:** Kilo `kilo-auto/free` when configured, then OpenRouter free routing, then other configured providers.
- **One tool plane:** Dyad native engineering tools. Meta-reasoning tools are removed from the model-visible registry.
- **One extension plane:** curated MCP integrations only when they add a capability Dyad does not already own.
- **Repository intelligence:** small deterministic `tools/repo-intel` CLI/MCP. It has no model, no second agent, no repair loop, and no duplicate file/shell tool framework.

## Complexity removed

Removed from the default agent architecture:

- parallel `src/hybrid_builder` runtime;
- Repo-Intel LLM Brain/provider framework;
- Repo-Intel duplicate read/edit/bash framework;
- hidden proactive second-brain callbacks;
- meta-tools for deep-think/thought-tree/self-critique/multi-agent orchestration/prompt optimization/autonomous execution/vibe/methodology layers;
- duplicate thinking/prompt MCP servers;
- duplicate Git MCP from the default local catalog;
- stale generated reports and experimental artifacts;
- runtime `userData`, machine encryption key, caches and screenshots;
- package-lock in the Bun-first repository;
- machine-specific launch/test scripts that could read stored credentials.

## Security/trust corrections

- Provider credentials no longer imply Dyad Pro entitlement.
- `isDyadPro` runtime context again reflects actual Dyad Pro state.
- Auto/BYOK capability is independent of subscription state.
- Context7 catalog credential was removed; secrets resolve from environment/config only.
- Local MCP catalog is locked to: fetch, memory, Playwright, GitHub, Context7.
- Runtime shell-string execution in dev-server detection and code-review build checks was converted to argument-vector execution.
- Release bump Git/GitHub operations were converted to argument-vector execution and no longer reference removed `package-lock.json`.
- Repo-Intel release verification is fail-closed and cannot report VERIFIED when required commands were skipped or failed.

## Verification evidence completed here

### PASS — canonical policy gate

Command:

```bash
node scripts/verify-zenith.mjs
```

Result:

```text
ZENITH VERIFY: PASS
policy_digest=12387c0708bdb5fc4af111b0b03449eb22033c29540528c53946af0709eb3c22
model_visible_tools=50
```

The gate checks the canonical default agent/model, free-first Auto routing, Dyad Pro trust boundary, curated MCP catalog, retired meta-tools, no hidden second brain, Repo-Intel deterministic-only contract, distribution-secret prefixes and removed unsafe artifacts.

### PASS — dependency-free release utility tests

```bash
node --test \
  scripts/start-supervisor.test.mjs \
  scripts/copy-data-to-dev.test.mjs \
  scripts/unauthorized-release-alert.test.mjs
```

Result: **14/14 passed, 0 failed**.

### PASS — TypeScript syntax parse

Global TypeScript 5.8.3 parsed all TypeScript-family source files without dependency resolution.

Result: **2,147 files parsed, 0 syntax errors**.

This is a syntax gate, not a semantic typecheck.

### PASS — Repo-Intel deterministic risk scan

```bash
node tools/repo-intel/cli.mjs scan .
```

Result: `[]` — no findings under the current runtime-focused secret/Electron/shell-execution rules.

### PASS — source credential sweep

No live-looking Groq, GitHub PAT, Context7, generic long `sk-...` credential or private-key block was found in distributable source/config outside explicit test/fixture exclusions.

### PASS — Repo-Intel fails closed

Without execution permission:

```text
status = DESIGNED
```

With execution requested in this environment:

```text
status = BLOCKED
reason = spawnSync bun ENOENT
```

It did **not** claim VERIFIED.

## Gates blocked by this environment

The audit container does not provide Bun and cannot resolve the package registry. Therefore the following claims are intentionally **not** made:

- fresh `bun install --frozen-lockfile` passed;
- semantic TypeScript typecheck passed;
- full Vitest suite passed;
- Electron/Vite production build passed;
- Playwright/E2E suite passed;
- packaged application smoke test passed.

Run the full consolidated release gate with:

```bash
bun run release:zenith
```

Or run the gates individually on a normal development machine with Bun/network access:

```bash
bun install --frozen-lockfile
bun run verify:zenith
bun run ts
bun run test
bun run build
REPO_INTEL_ALLOW_EXEC=1 bun run repo:intel:verify
```

The release is production-eligible only when every mandatory gate completes successfully at the same source revision.

## Repository provenance

The source input was an archive and contained no `.git` metadata, so an original Git commit SHA cannot be proven from the artifact. The generated distribution includes a source SHA-256 manifest and ZIP digest for this exact release candidate.
