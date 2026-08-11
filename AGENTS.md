# Dyad Custom Build — Agent Guide

> **Fork of [dyad-sh/dyad](https://github.com/dyad-sh/dyad)** with all Pro features unlocked,
> auto provider removed, and Vite/Next.js dual compatibility.

## Build Identity

- **Base**: Dyad v1.10.0-beta.3 (forked from `dyad-sh/dyad`)
- **License**: FSL-1.1-ALv2 on `src/pro/` (converts to Apache 2.0 after 2 years)
- **License**: Apache 2.0 on everything outside `src/pro/`
- **Modifications**: Pro unlocked, auto provider removed, SSR-compatible Annotator, bun-only
- **Package manager**: bun (replaces all upstream npm usage)
- **Node requirement**: `>=24 <26`
- **Bun requirement**: `>=1.0.0`

---

## Architecture Decisions — Custom Modifications

### 1. Pro Features Unlocked

**What changed**: `isDyadProEnabled()` and `hasDyadProKey()` in `src/lib/schemas.ts` always return `true` regardless of user settings. The `enableDyadPro` setting is still stored but ignored.

**Why**: This is a self-hosted/custom build where all Pro features (lazy edits, smart context, web search, free models) are available to all users without subscription.

**Files affected**:

- `src/lib/schemas.ts` — `isDyadProEnabled()` and `hasDyadProKey()` hardcoded to `true`
- All 87 call sites across the codebase that check `isDyadProEnabled` or `hasDyadProKey`

**Trade-offs and risks**:

- Pro engine features (lazy edits, smart context, web search) still depend on a valid Dyad Pro API key for the engine routing path. The `get_model_client.ts` still checks `settings.enableDyadPro && dyadApiKey` before enabling the engine path. If the API key is absent, the engine path is skipped and direct provider connections are used.
- The `isBasicAgentMode()` function returns `false` (since `isDyadProEnabled` is always true), which means users are never in "basic agent mode" — they always appear as Pro.
- UI components like `ProBanner`, `PromoMessage`, `ChatErrorBox`, and `ChatModeSelector` will always render in Pro mode. Some promo/upgrade UI will be hidden but still present in the code.
- The `getEffectiveDefaultChatMode()` function always sees `isPro === true` and defaults to `"local-agent"` mode.

**What to watch**: If you see unexpected behavior in chat mode selection, model picker visibility, or Pro engine routing, check whether the caller is using `settings.enableDyadPro` directly (which is a user setting) vs. `isDyadProEnabled(settings)` (which is the hardcoded function).

### 2. Auto Provider Removed

**What changed**: The `"auto"` provider in `src/lib/schemas.ts` still exists in the providers array for backwards compatibility, but `get_model_client.ts` now routes `"auto"` provider calls to the user's `settings.selectedModel` instead of a dedicated auto-routing service.

**Default model**: The current default `selectedModel` in `src/main/settings.ts` is `{ name: "mimo-v2.5", provider: "opencode" }`. This overrides the upstream default of `{ name: "auto", provider: "auto" }` and is a later change from ADR-002 (which had set `gpt-4o/openai`). When reasoning about fresh installs or test harness shapes, use `mimo-v2.5/opencode` as the concrete default.

**Why**: The upstream auto provider routes to Dyad's own model selection service, which requires Pro API keys and centralized routing. In a custom build, this service is not available, so users should select their own models directly.

**Files affected**:

- `src/ipc/utils/get_model_client.ts` — Lines 149-168: `auto` provider recursively calls `getModelClient` with `settings.selectedModel`
- `src/lib/schemas.ts` — `"auto"` still in providers array
- `src/components/ModelPicker.tsx` — Still references `"auto"` provider rows
- `src/components/settings/ProviderSettingsPage.tsx` — `isDyad` check for `provider === "auto"`
- `src/components/chat/MessagesList.tsx` — Checks `selectedModel?.provider === "auto"`
- `src/hooks/useTrialModelRestriction.ts` — `AUTO_MODEL = { name: "auto", provider: "auto" }`
- `src/components/HelpDialog.tsx` — Checks `settings?.providerSettings?.["auto"]?.apiKey?.value`
- `src/ipc/handlers/help_bot_handlers.ts` — Reads `settings.providerSettings?.["auto"]?.apiKey?.value`
- `src/app/TitleBar.tsx` — Routes to `provider: "auto"` settings page
- `src/testing/hybrid_chat_harness.tsx` — Default provider `"auto"` in test harness

**Trade-offs and risks**:

- The `"auto"` provider still appears in the providers list in `schemas.ts`. UI code that checks `providerId === "auto"` (ModelPicker, ProviderSettingsPage) still works.
- Tests still reference `{ provider: "auto", name: "auto" }` as default model shapes. These tests pass because `getModelClient` handles the `auto` case.
- The recursive call in `getModelClient` for `auto` provider could stack-overflow if `settings.selectedModel` itself has `provider: "auto"`. In practice this should not happen since the selected model is always a concrete provider.
- `HelpDialog` and `help_bot_handlers` check for `providerSettings?.["auto"]?.apiKey?.value` — this is the Dyad Pro API key field. Since Pro is unlocked, this value matters for engine routing.

### 3. SSR-Compatible Annotator

**What changed**: New files `src/pro/ui/components/Annotator/AnnotatorCompat.tsx` and updated `src/pro/ui/components/Annotator/index.ts` provide an SSR-safe wrapper for the Annotator component.

**Why**: The Annotator depends on `react-konva`, which imports Konva.js — a library that accesses `window` and `document` at module load time. In a server environment (Next.js SSR/SSG), this causes a crash. The wrapper uses `React.lazy` + dynamic `import()` to prevent the module from being evaluated on the server.

**Files affected**:

- `src/pro/ui/components/Annotator/AnnotatorCompat.tsx` — New SSR wrapper (122 lines)
- `src/pro/ui/components/Annotator/index.ts` — Barrel exports: `AnnotatorCompat` is the default export; `Annotator` (raw) is also exported for Vite/Electron use

**Trade-offs and risks**:

- In Vite/Electron, the lazy chunk is fetched once and cached; the Suspense boundary resolves almost immediately. Overhead is negligible.
- In Next.js SSR, the component renders only the placeholder on the server, then hydrates with the real canvas on the client. Users may see a brief loading spinner.
- The barrel export structure means import paths matter:
  - `import { Annotator } from "./Annotator"` — raw component (Vite/Electron only)
  - `import { AnnotatorCompat } from "./Annotator"` — SSR-safe (use everywhere)
  - `import Annotator from "./Annotator"` — default = AnnotatorCompat (safest)
- `AnnotationCanvas` is also re-exported for consumers building custom wrappers.

### 4. Build System Migrated to Bun

**What changed**: All `package.json` scripts now use `bun` instead of `npm`. The `engines` field includes `"bun": ">=1.0.0"`, and `packageManager` is set to `"bun@1.2.21"`.

**Why**: Bun provides faster install times, faster script execution, and better compatibility with the project's native modules.

**Files affected**:

- `package.json` — All scripts migrated to `bun run`, `bunx`
- `package.json` — `engines.bun` and `packageManager` fields added

**Trade-offs and risks**:

- `package-lock.json` still exists in the repo (from upstream). With bun, you may also have `bun.lock` or `bun.lockb`. The `package-lock.json` is not used by bun but should not be deleted — it documents the upstream dependency tree.
- Some npm references remain in `rules/` documentation (72 occurrences). These were NOT rewritten because `rules/` files are read-only references for agents and the npm commands are still syntactically valid (bun supports `npm run <script>` for backwards compat). However, prefer `bun run` for consistency.
- `testing/fake-llm-server/` still has `package-lock.json`. Use `bun install` in that directory as well.
- Native modules (`better-sqlite3`, `node-pty`, `dugite`, `@vscode/ripgrep`) should compile with bun. If you hit `NODE_MODULE_VERSION` mismatches, use `bun rebuild <package>` (equivalent to `npm rebuild`).

---

## Edge Cases and Gotchas

### Files that still reference "auto" provider

The following source files still contain `"auto"` provider references that need attention if you modify provider logic:

| File                                                   | Context                                     |
| ------------------------------------------------------ | ------------------------------------------- |
| `src/lib/schemas.ts:72`                                | `"auto"` in providers array                 |
| `src/ipc/utils/get_model_client.ts:149`                | `model.provider === "auto"` routing         |
| `src/components/ModelPicker.tsx:291,390,632,670`       | Auto provider row rendering and selection   |
| `src/components/settings/ModelsSection.tsx:212`        | `providerId !== "auto"` conditional         |
| `src/components/settings/ProviderSettingsPage.tsx:116` | `isDyad` = `provider === "auto"`            |
| `src/components/chat/MessagesList.tsx:620`             | `selectedModel?.provider === "auto"` check  |
| `src/components/HelpDialog.tsx:275`                    | `providerSettings?.["auto"]?.apiKey?.value` |
| `src/app/TitleBar.tsx:242`                             | `params: { provider: "auto" }` navigation   |
| `src/hooks/useTrialModelRestriction.ts:6,15`           | `AUTO_MODEL` constant and check             |
| `src/ipc/handlers/help_bot_handlers.ts:67`             | `providerSettings?.["auto"]?.apiKey?.value` |
| `src/testing/hybrid_chat_harness.tsx:940`              | Default provider `"auto"`                   |

Test files referencing `"auto"` provider (not exhaustive): `ModelPicker.test.tsx`, `schemas.test.ts`, `get_model_client.test.ts`, `freeProModel.test.ts`, `chatMode.test.ts`, `homeChatMode.test.ts`, `useChatMode.test.tsx`, `posthogTelemetry.test.ts`, `PromoMessage.test.ts`, `settings.test.ts`, `chat_mode_precondition.test.ts`, `chat_mode_resolution.test.ts`, `llm_engine_provider.test.ts`, `explore_code_subagent.spec.ts`.

### Pro gating bypass locations

The following functions/locations implement the Pro gate. With `isDyadProEnabled` always returning `true` and `hasDyadProKey` always returning `true`, these behave as if the user always has Pro:

| Function                        | File                     | Effect of override                                                  |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `isDyadProEnabled()`            | `src/lib/schemas.ts:521` | Always `true`                                                       |
| `hasDyadProKey()`               | `src/lib/schemas.ts:526` | Always `true`                                                       |
| `isBasicAgentMode()`            | `src/lib/schemas.ts:580` | Always `false` (Pro users are not "basic")                          |
| `isTurboEditsV2Enabled()`       | `src/lib/schemas.ts:597` | Depends on `enableProLazyEditsMode` and `proLazyEditsMode` settings |
| `getEffectiveDefaultChatMode()` | `src/lib/schemas.ts:554` | Always returns `"local-agent"` for Pro                              |

UI components that check Pro status (all now see Pro as enabled):

- `src/app/TitleBar.tsx` — `isDyadPro` / `isDyadProEnabled`
- `src/components/ModelPicker.tsx` — `dyadProEnabled`
- `src/components/ChatPanel.tsx` — `isDyadProEnabled`
- `src/components/ProModeSelector.tsx` — `hasDyadProKey`
- `src/components/ChatModeSelector.tsx` — `isProEnabled`
- `src/components/DefaultChatModeSelector.tsx` — `isProEnabled`
- `src/components/ProBanner.tsx` — `hasDyadProKey`
- `src/components/settings/ProviderSettingsPage.tsx` — `hasDyadProKey`
- `src/components/chat/PromoMessage.tsx` — `hasProKey`
- `src/components/chat/ChatErrorBox.tsx` — `isDyadProEnabled`
- `src/components/chat/ChatInput.tsx` — `isProEnabled`
- `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts` — `isDyadProEnabled`
- `src/pro/main/ipc/handlers/themes_handlers.ts` — no longer reads `settings.enableDyadPro` directly (resolved)

### Electron-specific patterns that break in Next.js

If you extend this build to work in Next.js, watch for:

- **`electron-log`** — Used throughout `src/` for logging. Not available in browser/Node.js environments without Electron. Import patterns: `import log from "electron-log"`. Affected: `src/main.ts`, `src/backup_manager.ts`, `src/supabase_admin/*.ts`, `src/user_input/main.ts`, `src/pro/main/ipc/processors/search_replace_processor.ts`, `src/pro/main/ipc/handlers/themes_handlers.ts`, `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts`.
- **`ipcRenderer` / `contextBridge`** — `src/preload.ts` uses Electron's IPC primitives. Not available in a browser.
- **`better-sqlite3`** — Native SQLite binding. Requires native compilation; not available in serverless/browser environments. Used in `src/db/index.ts`, `src/backup_manager.ts`.
- **`node-pty`** — Terminal emulation. Native module. Used in `src/ipc/utils/pty_command_runner.ts`.
- **`dugite`** — Bundled Git. Native binary. Used for Git operations.
- **`@vscode/ripgrep`** — Native binary for code search.
- **`electron-squirrel-startup`** — Windows auto-update support.
- **`node_modules/.bin/oxfmt`** — Formatter binary expected after install.

The Annotator SSR wrapper (`AnnotatorCompat.tsx`) specifically addresses the `react-konva` / `konva` incompatibility.

### Vite-specific patterns that break in Electron

- **`import.meta.env.MODE`** — Used in `src/renderer.tsx`. Vite replaces this at build time. Works in both Vite (Electron) and Next.js (via `process.env.NODE_ENV`).
- **`MAIN_WINDOW_VITE_DEV_SERVER_URL`** — Global injected by Vite plugin in `src/main.ts`. Only available during Electron development.
- **Path aliases (`@/...`)** — Configured via Vite's `resolve.alias` in the Forge/Vite config. Work in Electron but may not resolve in Next.js without equivalent `tsconfig.json` paths.

### IPC Security Boundaries

The Electron IPC architecture is a core security boundary:

- **Renderer -> Main**: All communication goes through `src/preload.ts` which exposes a limited `electronAPI` via `contextBridge`. The renderer never has direct access to `ipcRenderer`.
- **Channel validation**: IPC handlers validate inputs and throw `DyadError` with appropriate `DyadErrorKind` values.
- **Shared contract code**: `src/ipc/contracts/` defines the IPC contract. When editing files imported by `src/preload.ts`, run `bun run build` before E2E testing — the preload Vite target may not resolve `@/...` aliases.
- **Window security policy**: `src/main/window_security.ts` enforces navigation locks and popup window security. All preview popups are created with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`. Navigation outside the app origin is blocked. Do not weaken these settings; run `bun run test -- src/main/window_security.test.ts` after any changes to this file.

### Database Migration Risks

- The database uses Drizzle ORM with SQLite (`better-sqlite3`).
- Schema is in `src/db/schema.ts`. Generate migrations with `bun run db:generate`.
- `createInMemoryTestDb()` applies real `./drizzle` migrations, so virtual tables and triggers are exercised in unit tests.
- After rebasing with migration conflicts, do a clean reset: remove extra `drizzle/00XX_*.sql` files, reset `drizzle/meta`, and run `bun run db:generate`.
- **Bun compatibility**: Drizzle Kit (`^0.30.6`) and Drizzle ORM (`^0.41.0`) should work with bun. If you hit issues, check the drizzle-orm changelog for bun-specific fixes.

### Native Module Compatibility with Bun

Native modules that must survive packaging:

| Module                 | Used for           | Notes                                                                                  |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `better-sqlite3`       | SQLite database    | Rebuild with `bun rebuild better-sqlite3` if NODE_MODULE_VERSION mismatch              |
| `node-pty`             | Terminal emulation | Rebuild with `bun rebuild node-pty`                                                    |
| `dugite`               | Bundled Git        | Ships `git` binary; verify `node_modules/dugite/git/bin/git` exists after install      |
| `@vscode/ripgrep`      | Code search        | Verify `node_modules/@vscode/ripgrep/bin/rg` exists after install                      |
| `dyad-keychain-reader` | macOS Keychain     | Local package in `native/keychain-reader`; built via `bun run rebuild:keychain-reader` |

If `bun install` produces a `spawn ELOOP` or silent exit code 194 in sandboxed sessions, use `bun install --ignore-scripts` and manually rebuild.

---

## Project Setup

Please read `CONTRIBUTING.md` which includes information for human code contributors. Much of the information is applicable to you as well.

### Install dependencies

```sh
bun install
```

**Note:** bun does not use `package-lock.json`. The lockfile is `bun.lock` or `bun.lockb`. Do not delete `package-lock.json` — it documents the upstream dependency tree.

### Create the userData directory (required for database)

```sh
mkdir -p userData
```

### Set up pre-commit hooks

Run this once after `bun install` to enable linting and formatting on commit:

```sh
bun run init-precommit
```

**Note:** Running `bun install` may update `bun.lock` with version changes or peer dependency flag removals. If rebasing or performing git operations, commit these changes first to avoid "unstaged changes" errors.

### Git worktrees

When you create a new git worktree for this repository, run `bun install` inside the new worktree before starting development. Each worktree has its own working directory and needs its dependencies installed there.

After installation, verify that `node_modules/.bin/oxfmt` exists before running formatting. If `bun install` reports success without materializing `node_modules`, run `bun install --frozen-lockfile`; otherwise `bunx` may download an unpinned formatter and rewrite unrelated files.

Also run `bun install` in `testing/fake-llm-server/` before `bun run ts` in a fresh worktree. Otherwise the root type-check reports missing declarations for that package's local `express` and `cors` dependencies.

---

## Rules Index

> **IMPORTANT: BEFORE writing any code or making changes, you MUST read the relevant rule files from the table below.** Identify which areas your task touches and read those rule files first. Skipping this step leads to avoidable mistakes and rework.

Detailed rules and learnings are in the `rules/` directory. Read the relevant file when working in that area.

| File                                                                       | Read when...                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [rules/electron-ipc.md](rules/electron-ipc.md)                             | Adding/modifying IPC endpoints, handlers, React Query hooks, or renderer-to-main communication                                                                                 |
| [rules/app-operation-coordination.md](rules/app-operation-coordination.md) | Adding/modifying main-process operations that coordinate app paths, runtime, Git, providers, chats, media, tests, or app deletion                                              |
| [rules/dyad-errors.md](rules/dyad-errors.md)                               | Classifying IPC/main errors with `DyadError` / `DyadErrorKind` and PostHog exception filtering                                                                                 |
| [rules/local-agent-tools.md](rules/local-agent-tools.md)                   | Adding/modifying local agent tools, tool flags (`modifiesState`), or read-only/plan-only guards                                                                                |
| [rules/e2e-testing.md](rules/e2e-testing.md)                               | Writing or debugging E2E tests (Playwright, Base UI radio clicks, Lexical editor, test fixtures)                                                                               |
| [rules/hybrid-testing.md](rules/hybrid-testing.md)                         | Writing or debugging Vitest integration tests, especially renderer+IPC harness tests and fake Dyad Engine/Gateway routing                                                      |
| [rules/git-workflow.md](rules/git-workflow.md)                             | Pushing branches, creating PRs, or dealing with fork/upstream remotes                                                                                                          |
| [rules/base-ui-components.md](rules/base-ui-components.md)                 | Using TooltipTrigger, ToggleGroupItem, or other Base UI wrapper components                                                                                                     |
| [rules/database-drizzle.md](rules/database-drizzle.md)                     | Modifying the database schema, generating migrations, or resolving migration conflicts                                                                                         |
| [rules/native-modules.md](rules/native-modules.md)                         | Adding Electron native modules or binaries that must survive Forge packaging/rebuild                                                                                           |
| [rules/typescript-strict-mode.md](rules/typescript-strict-mode.md)         | Debugging type errors from `bun run ts` (tsgo) that pass normal tsc                                                                                                            |
| [rules/openai-reasoning-models.md](rules/openai-reasoning-models.md)       | Working with OpenAI reasoning model (o1/o3/o4-mini) conversation history                                                                                                       |
| [rules/prompt-guides.md](rules/prompt-guides.md)                           | Editing prompt guide Markdown under `src/prompts/guides/` or prompt assembly snapshots                                                                                         |
| [rules/adding-settings.md](rules/adding-settings.md)                       | Adding a new user-facing setting or toggle to the Settings page                                                                                                                |
| [rules/chat-mentions.md](rules/chat-mentions.md)                           | Modifying chat input mention parsing, `@app:` formatting, Lexical mention sync, or referenced app extraction                                                                   |
| [rules/chat-message-indicators.md](rules/chat-message-indicators.md)       | Using `<dyad-status>` tags in chat messages for system indicators                                                                                                              |
| [rules/chat-modes.md](rules/chat-modes.md)                                 | Adding or modifying features that select, create, persist, or fall back between Agent, Build, Ask, and Plan modes                                                              |
| [rules/supabase-functions.md](rules/supabase-functions.md)                 | Deploying, bundling, or queueing Supabase Edge Functions                                                                                                                       |
| [rules/product-principles.md](rules/product-principles.md)                 | Planning new features, especially via `dyad:swarm-to-plan`, to guide design trade-offs                                                                                         |
| [rules/jotai-testing.md](rules/jotai-testing.md)                           | Unit-testing Jotai atoms/hooks with `renderHook`, especially across unmount/remount                                                                                            |
| [rules/jotai-state.md](rules/jotai-state.md)                               | Adding or refactoring Jotai atoms, especially deciding React Query vs Jotai ownership, entity-keyed state, derived atoms, and async runtime state                              |
| [rules/claude-github-workflows.md](rules/claude-github-workflows.md)       | Editing `.github/workflows/*.yml` that invoke `anthropics/claude-code-action` — workflow shape, untrusted-input handling, and **permission/`.claude/settings.json` hardening** |
| [rules/ui-styling.md](rules/ui-styling.md)                                 | Adding provider/brand icons, styling scrollable popovers, or using Tailwind v4 arbitrary values                                                                                |
| [rules/auto-update.md](rules/auto-update.md)                               | Debugging Squirrel/update-electron-app failures, update feed URLs, or updater log capture in bug reports and session debug bundles                                             |
| [rules/safe-storage.md](rules/safe-storage.md)                             | Working with Electron `safeStorage`, macOS Keychain identities, or legacy os_crypt secret recovery                                                                             |
| [rules/electron-workers.md](rules/electron-workers.md)                     | Spawning `worker_threads`/`utilityProcess`, moving heavy computation off the main process, or diagnosing main-process memory usage and OOM crashes                             |
| [rules/app-naming.md](rules/app-naming.md)                                 | Touching app display names, folder slugs, or flows that create/move app directories (create, copy, import, rename, blueprint approval, template apply)                         |
| [rules/state-machines.md](rules/state-machines.md)                         | Adding or modifying explicit state machines, transition functions, controllers, command runners, keyed hosts, or renderer bindings                                             |
| [rules/windows-spawn.md](rules/windows-spawn.md)                           | Spawning child processes with arguments on Windows — `.cmd` shim resolution and what `cmd.exe` quoting can and cannot contain                                                  |
| [rules/i18n.md](rules/i18n.md)                                             | Adding translation keys to `src/i18n/locales/*/chat.json` or building i18n-aware chat tool cards                                                                               |

> **Note on rules/ references**: The `rules/` files reference `npm` commands (72 occurrences). These are preserved verbatim from upstream because the rules contain domain-specific guidance (migration strategies, failure modes, debugging workflows) that is valuable as-is. For actual command execution in this build, always use `bun` equivalents (see [Commands](#commands) below). When a rules file says `npm run build`, execute `bun run build` instead.

---

## Commands

All commands use **bun**. Do not use `npm`, `npx`, or `pnpm` for this project.

### Development

```sh
# Install dependencies
bun install

# Start development server
bun run dev

# Start with custom engine URL
bun run dev:engine
```

### Pre-commit Checks

Run these before every commit:

**Formatting:**

```sh
bun run fmt
```

**Check formatting without modifying:**

```sh
bun run fmt:check
```

**Linting:**

```sh
bun run lint
```

**Fix lint errors:**

```sh
bun run lint:fix
```

> **WARNING: Do NOT run `bunx eslint` directly.** The project uses **oxlint** (not eslint) via `bun run lint`. Running `bunx eslint <file>` produces spurious `import/no-unresolved` errors for `@/...` path aliases and other false positives.

> **WARNING: Never run `bunx oxlint --fix` or `bunx oxfmt` before `node_modules` is installed.** Without the pinned local binary, bun may download the latest version, which can rewrite files differently. Use `./node_modules/.bin/oxlint` / `./node_modules/.bin/oxfmt`, and check `git status` for collateral edits.

**Type-checks:**

```sh
bun run ts
```

> **WARNING: Do NOT run `npx tsc` or `tsc` directly.** The project is not set up for direct `tsc` invocation. Always use `bun run ts` which uses `tsgo` with the correct configuration.

**Presubmit (fmt check + lint):**

```sh
bun run presubmit
```

### Database

```sh
# Generate migrations
bun run db:generate

# Push schema changes
bun run db:push

# Open Drizzle Studio
bun run db:studio
```

### Building

```sh
# Build for E2E testing
bun run build

# Package the Electron app
bun run package

# Create distributable
bun run make

# Publish release
bun run publish
```

### Testing

```sh
# Run all tests
bun run test

# Run specific test file
bun run test -- path/to/file.test.ts

# Run tests in watch mode
bun run test:watch

# Run tests with UI
bun run test:ui

# Run eval tests
bun run eval
```

### E2E Testing

```sh
# Build first (REQUIRED before E2E)
bun run build

# Run E2E tests
bun run e2e

# Run E2E with retries disabled
bun run e2e:fast

# Run specific E2E spec
PLAYWRIGHT_HTML_OPEN=never bun run e2e -- e2e-tests/<spec>.ts

# Update E2E snapshots
PLAYWRIGHT_HTML_OPEN=never bun run e2e -- e2e-tests/<spec>.ts --update-snapshots
```

> **IMPORTANT: You MUST run `bun run build` before running E2E tests.** E2E tests run against the built application, not the dev server. If you have changed any application code, you MUST re-run `bun run build` before running the tests.

### Storybook

```sh
bun run storybook
bun run build-storybook
```

### Benchmarks

```sh
bun run benchmark:code-explorer
bun run benchmark:code-explorer:smoke
bun run benchmark:code-explorer:full
bun run benchmark:code-explorer:suite
```

### Utilities

```sh
# Clean build artifacts
bun run clean

# Bump version
bun run bump

# Copy data to dev environment
bun run copy-data-to-dev

# Verify release assets
bun run verify-release
```

---

## Project Context

- This is an **Electron application** with a secure IPC boundary.
- Frontend is a **React app** that uses TanStack Router (not Next.js or React Router) in the Electron context.
- Data fetching/mutations should be handled with TanStack Query when touching IPC-backed endpoints.
- Main-process IPC errors that are **not bugs** (validation, missing entities, auth, user refusal, etc.) should be thrown as **`DyadError`** with a **`DyadErrorKind`** so they can be excluded from PostHog exception telemetry. See [rules/dyad-errors.md](rules/dyad-errors.md).
- **UI primitives**: Always use Base UI (`@base-ui/react`), never Radix UI. See [rules/base-ui-components.md](rules/base-ui-components.md).
- **State management**: Jotai for renderer atoms, TanStack Query for IPC-backed data. See [rules/jotai-state.md](rules/jotai-state.md).

---

## Testing

Our project relies on a combination of unit tests, Vitest integration tests, and Playwright E2E tests. Unless your change is trivial, you MUST add a test; prefer the narrowest test type that proves the behavior.

### Unit Testing

Use unit testing for pure business logic and util functions.

Target a Vitest file with `bun run test -- path/to/file.test.ts`. Do not pass Jest-only flags such as `--runInBand`; Vitest will fail with `Unknown option '--runInBand'`.

The pinned Vitest version does not support `--repeat`; it fails with `Unknown option '--repeat'`. Stress-run a target by repeating the supported `bun run test -- path/to/file.test.ts` command externally.

Tests that inspect repository text files must account for Git's platform-specific line endings. Normalize newlines or match `\r?\n`; for a Windows-only failure, exercise synthetic LF and CRLF inputs locally so the regression does not depend on the runner OS.

When mocking a widely imported module such as `@/lib/schemas`, prefer a partial mock with `importOriginal` and override only the target exports. A full replacement can make unrelated transitive imports fail with `No "<export>" export is defined` as the module graph evolves.

When adding another suite or prerequisite to the root `test` script, keep Vitest as the final shell command. `bun run test -- <path>` appends its arguments only to the final command, so placing another runner last silently turns a targeted Vitest run into the full suite.

Package-local Vitest suites may use their own config and not match the root `bun run test -- path` include globs. For example, run `bun --cwd packages/ts-pg-schema-diff run test` and `bun --cwd packages/ts-pg-schema-diff run typecheck` for `packages/ts-pg-schema-diff`.

### Vitest Integration Testing

Use Vitest integration tests (`*.integration.test.ts` / `*.integration.test.tsx`) when the behavior spans real app modules such as IPC handlers, sqlite, git, fake LLM/Engine routes, or renderer+IPC wiring, but does not require a packaged Electron app or browser-only behavior. Prefer this over Playwright when you can assert the behavior through the chat-flow or renderer+IPC harness with deterministic fake services.

Use Playwright E2E instead when the test needs the packaged Electron runtime, real browser/Electron behavior, native dialogs, screenshots, Monaco/Lexical browser interactions, full navigation flows, or confidence that only the real app shell provides. See [rules/hybrid-testing.md](rules/hybrid-testing.md) for integration-test guidance and [rules/e2e-testing.md](rules/e2e-testing.md) for Playwright guidance.

If `bun run test` fails in files unrelated to your change, verify the failure is pre-existing before debugging: `git worktree add /tmp/main-check main`, symlink the repo's `node_modules` into it, and run the failing test file there. If it also fails on clean main, note it in the PR summary and move on.

### E2E Testing

> **IMPORTANT: You MUST run `bun run build` before running E2E tests.** E2E tests run against the built application, not the dev server. If you have changed any application code (i.e. anything outside of test files), you MUST re-run `bun run build` before running the tests, otherwise the tests will run against stale code and results will be misleading. Only changes to test code itself (e.g. files in `e2e-tests/`) do not require a rebuild.

See [rules/e2e-testing.md](rules/e2e-testing.md) for full E2E testing guidance, including Playwright tips and fixture setup.

**Debugging E2E test failures with screenshots:** When an E2E test fails and you can't determine the cause from the error message alone, use the `/dyad:debug-with-playwright` skill to add screenshots at key points in the test. Playwright's built-in `screenshot: "on"` does NOT work with Electron — you must use manual `page.screenshot()` calls.

---

## General Guidance

- Favor descriptive module/function names that mirror IPC channel semantics.
- Keep Electron security practices in mind (no `remote`, validate/lock by `appId` when mutating shared resources).
- **Never embed GitHub tokens in git remote URLs** (e.g., `https://<token>@github.com/...`) — they persist in plaintext in users' `.git/config` and leak via git error output. Native git network operations (clone/fetch/pull/push) in `src/ipc/utils/git_utils.ts` inject auth per-invocation via `getGitNetworkEnv(accessToken)` (`GIT_CONFIG_*` env vars); any new network-touching git command must pass this env or auth will silently be missing for private repos.
- Add tests in the same folder tree when touching renderer components.
- **Sandbox hook restrictions:** inline `python3 -c "..."` is blocked, and Python scripts only run when the file lives inside the repo's `.claude/` directory — write helper scripts to `.claude/tmp/` (and clean them up before committing).
- **Always use Base UI (`@base-ui/react`) for UI primitives, never Radix UI.** This includes menus, tooltips, accordions, context menus, and other headless UI components. See [rules/base-ui-components.md](rules/base-ui-components.md) for component-specific guidance.
- **Pro features**: Since this is a custom build, all Pro features are available. Do not add Pro gates or subscription checks. If you need to conditionally enable a feature, use feature flags in the Experiments schema instead.

---

## Git Workflow

When pushing changes and creating PRs:

1. If the branch already has an associated PR, push to whichever remote the branch is tracking.
2. If the branch hasn't been pushed before, default to pushing to `origin` (the fork), then create a PR from the fork to the upstream repo (`dyad-sh/dyad`).
3. If you cannot push to the fork due to permissions, push directly to `upstream` (`dyad-sh/dyad`) as a last resort.

### Skipping Automated Review

Add `#skip-bugbot` to the PR description for trivial PRs that won't affect end-users, such as:

- Claude settings, commands, or agent configuration
- Linting or test setup changes
- Documentation-only changes
- CI/build configuration updates
