import { describe, it, expect } from "vitest";
import {
  parseCompilationError,
  isCompilationErrorLine,
} from "./dev_server_error_parser";

// ============================================================================
// parseCompilationError
// ============================================================================

describe("parseCompilationError", () => {
  // ── Next.js errors ──────────────────────────────────────────────────

  it("detects Next.js Module not found error", () => {
    const stderr = `Error: ./src/app/api/ai/chat/route.ts:7:1
Error: Module not found: Can't resolve '@/lib/personas'
   5 | import { logger } from "@/lib/logger";
   6 | import { validateBody, aiChatSchema } from "@/lib/validations";
>  7 | import { buildSystemPrompt } from "@/lib/personas";
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   8 |
   9 | // POST /api/ai/chat — AI assistant chat endpoint`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("nextjs");
    expect(result!.fixable).toBe(true);
    expect(result!.summary).toContain("Module not found");
    expect(result!.rawOutput).toContain("@/lib/personas");
  });

  it("detects Next.js Type error", () => {
    const stderr = `Type error: Type 'string' is not assignable to type 'number'.
  12 |   const x: number = "hello";
     |                     ^~~~~~~~`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("nextjs");
    expect(result!.fixable).toBe(true);
    expect(result!.summary).toContain("Type error");
  });

  it("detects Next.js Failed to compile", () => {
    const stderr = `Failed to compile.
./src/app/page.tsx
Module not found: Can't resolve './components/Missing'`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("nextjs");
  });

  // ── Vite errors ─────────────────────────────────────────────────────

  it("detects Vite Pre-transform error", () => {
    const stderr = `Pre-transform error in /src/App.tsx: Cannot find module '@vitejs/plugin-react'`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("vite");
    expect(result!.fixable).toBe(true);
  });

  it("detects Vite esbuild-style error", () => {
    const stderr = `error src/App.tsx(12:5): Unexpected token`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("vite");
  });

  // ── TypeScript errors ───────────────────────────────────────────────

  it("detects TypeScript TS error code", () => {
    const stderr = `src/utils/helper.ts(42,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("typescript");
    expect(result!.fixable).toBe(true);
  });

  it("detects TypeScript error without 'error' prefix", () => {
    const stderr = `TS2304: Cannot find name 'Props'.`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("typescript");
  });

  // ── Webpack errors ──────────────────────────────────────────────────

  it("detects Webpack Module build failed", () => {
    const stderr = `Module build failed (from ./node_modules/babel-loader/index.js):
ModuleSyntaxError: Unexpected token`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("webpack");
  });

  // ── Generic errors ──────────────────────────────────────────────────

  it("detects generic Cannot find module", () => {
    const stderr = `Error: Cannot find module './src/lib/utils'
    at Function.resolve (internal/modules/cjs/loader:1068:15)`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("generic");
    expect(result!.fixable).toBe(true);
  });

  it("detects generic SyntaxError", () => {
    const stderr = `/src/app/page.tsx: Unexpected token (12:5)
SyntaxError: /src/app/page.tsx: Unexpected token (12:5)`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("generic");
  });

  it("detects ENOENT missing file", () => {
    const stderr = `ENOENT: no such file or directory, open '/src/config.json'`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    expect(result!.fixable).toBe(true);
  });

  // ── Combined stdout + stderr ────────────────────────────────────────

  it("detects errors spanning stdout and stderr", () => {
    const stdout = `> my-app@1.0.0 dev
> next dev

  ▲ Next.js 14.2.0
  - Local:        http://localhost:3000`;
    const stderr = `Error: Module not found: Can't resolve '@/lib/personas'`;

    const result = parseCompilationError(stdout, stderr);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe("nextjs");
  });

  // ── Anti-patterns (should NOT match) ────────────────────────────────

  it("does not match deprecation warnings", () => {
    const stderr = `(node:1234) [DEP0040] DeprecationWarning: The 'punycode' module is deprecated.`;
    const result = parseCompilationError("", stderr);
    expect(result).toBeNull();
  });

  it("does not match pnpm ignored builds error", () => {
    const stderr = `ERR_PNPM_IGNORED_BUILDS  Cannot install with all dependencies hoisted`;
    const result = parseCompilationError("", stderr);
    expect(result).toBeNull();
  });

  it("does not match normal log output with 'error' in it", () => {
    const stderr = `23:19:29.048 (pro_handlers) › error handling middleware loaded`;
    const result = parseCompilationError("", stderr);
    expect(result).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseCompilationError("", "")).toBeNull();
    expect(parseCompilationError("", "   ")).toBeNull();
  });

  // ── Buffer bounds ───────────────────────────────────────────────────

  it("finds error near end of large output", () => {
    const padding = "a".repeat(20000);
    const stderr = `${padding}\nError: Cannot find module './missing'`;
    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
  });

  // ── Multiple errors ─────────────────────────────────────────────────

  it("returns the highest-weight error when multiple exist", () => {
    const stderr = `SyntaxError: Unexpected token
TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
Module not found: Can't resolve '@/lib/personas'`;

    const result = parseCompilationError("", stderr);
    expect(result).not.toBeNull();
    // "Module not found" has weight 10 (highest)
    expect(result!.summary).toContain("Module not found");
  });
});

// ============================================================================
// isCompilationErrorLine
// ============================================================================

describe("isCompilationErrorLine", () => {
  it("returns true for Next.js Module not found", () => {
    expect(
      isCompilationErrorLine(
        "Error: Module not found: Can't resolve '@/lib/personas'",
      ),
    ).toBe(true);
  });

  it("returns true for TypeScript error code", () => {
    expect(isCompilationErrorLine("error TS2345: Type mismatch")).toBe(true);
  });

  it("returns true for SyntaxError", () => {
    expect(isCompilationErrorLine("SyntaxError: Unexpected token")).toBe(true);
  });

  it("returns false for deprecation warning", () => {
    expect(
      isCompilationErrorLine(
        "(node:1234) [DEP0040] DeprecationWarning: The 'punycode' module is deprecated.",
      ),
    ).toBe(false);
  });

  it("returns false for pnpm ignored builds", () => {
    expect(isCompilationErrorLine("ERR_PNPM_IGNORED_BUILDS")).toBe(false);
  });

  it("returns false for normal log output", () => {
    expect(
      isCompilationErrorLine(
        "23:19:29 (app_handlers) › error handling middleware loaded",
      ),
    ).toBe(false);
  });
});
