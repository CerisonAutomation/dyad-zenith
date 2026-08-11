# Guide: Rigorous Code Review Before Done

Use this before declaring any change complete. Review like a skeptical senior engineer, not the author. Never say "it works" without checking the wiring.

## 1. Correctness

- Trace every function call: does it resolve to a defined function with the right arity and argument types?
- Check data structures between creators and consumers (defaults vs renderers, DB rows vs UI fields).
- Verify API/route/contract field names against the canonical reference — never assume names from memory.
- Check edge cases: empty arrays, nulls, zero, unicode, timezones, pagination boundaries.

## 2. Wiring

- Are new components/pages/tools registered? (exports, manifests, routes, nav, parent imports)
- Do all asset paths (scripts, stylesheets, images, icons) resolve to real files?
- Are all imports used, and is nothing importing deleted exports?
- Does the feature appear where users expect it (page tree, route config, menus)?

## 3. Error handling

- Every external call (network, fs, DB, IPC) has a failure path — no unhandled rejections.
- Errors are caught at the right layer, logged with context, and surfaced to the user in plain language.
- Degradation is graceful: a broken optional dependency must not crash the whole app.

## 4. Security & hygiene

- No secrets in code, logs, or commits; no plaintext credential storage.
- Input validation on anything user-controlled (Zod/schema on all boundaries).
- No console.log spam; no commented-out dead code; no leftover TODO without an owner.

## 5. Verification evidence

- Run the actual checks: type checker, linter, tests, build. Record the results.
- If you can't run a check, say so — do not claim it passed.
- For UI changes, verify rendered output, not just that it compiles.

## Output format

Report findings as `file:line — issue — fix applied`. Distinguish:
- **FIXED**: changed in this pass.
- **BLOCKER**: cannot fix without user input (state exactly what is needed).
- **PASS**: verified clean.
