# Router startup crash fix — 2026-08-11

## Symptom

Dyad could render its fatal error boundary on startup/home with:

`Invariant failed: Could not find an active match from "/chat"`

## Root cause

`RootLayout` intentionally calls `useStreamChat({ hasChatId: false })` so the
first-prompt and global stream runtime can exist outside the chat page. However,
`useStreamChat` still performed a strict TanStack Router lookup:

`useSearch({ from: "/chat" })`

Strict route-scoped hooks throw when the specified route is not active. On `/`
(or another non-chat route), RootLayout therefore crashed before the app could
render normally.

## Fix

The shared hook now uses the exact chat route but does not throw if it is absent:

`useSearch({ from: "/chat", shouldThrow: false })`

The optional result is only used when `hasChatId` is true. This preserves exact
chat search semantics without reading unrelated search params from another route.

## Regression protection

1. `src/hooks/useStreamChat.test.tsx` simulates no active `/chat` match and
   verifies shared usage does not throw.
2. `e2e-tests/1.spec.ts` verifies the packaged app opens the home screen and does
   not render the TanStack invariant or Dyad fatal error boundary.
3. `scripts/verify-zenith.mjs` permanently checks the non-throwing route lookup.

## Additional final-pass hardening

The final pass also prevents external URL query/hash values from being written to
Electron logs; only origin + pathname are logged.
