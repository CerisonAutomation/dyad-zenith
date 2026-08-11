import { describe, it, expect } from "vitest";
import {
  analyzeFileWrite,
  shouldAutoTypeCheck,
  shouldAutoVibeScan,
  buildProactiveMessage,
  collectTurnTriggers,
} from "./auto_trigger";
import type { FileWriteEvent } from "./auto_trigger";

describe("auto_trigger", () => {
  describe("analyzeFileWrite", () => {
    it("returns no warnings for clean TypeScript files", () => {
      const event: FileWriteEvent = {
        filePath: "src/utils/helper.ts",
        content: `export function add(a: number, b: number) { return a + b; }`,
        toolName: "write_file",
      };
      const result = analyzeFileWrite(event);
      expect(result.triggered).toBe(false);
      expect(result.warnings).toBeUndefined();
    });

    it("detects 'any' type in TypeScript files", () => {
      const event: FileWriteEvent = {
        filePath: "src/utils/helper.ts",
        content: `function process(data: any) { return data; }`,
        toolName: "write_file",
      };
      const result = analyzeFileWrite(event);
      expect(result.triggered).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w) => w.includes("any"))).toBe(true);
    });

    it("detects eval() usage", () => {
      const event: FileWriteEvent = {
        filePath: "src/utils/evaluator.js",
        content: `eval("console.log('hello')");`,
        toolName: "write_file",
      };
      const result = analyzeFileWrite(event);
      expect(result.triggered).toBe(true);
      expect(result.warnings!.some((w) => w.includes("eval()"))).toBe(true);
    });

    it("detects innerHTML without sanitization", () => {
      const event: FileWriteEvent = {
        filePath: "src/components/RichText.tsx",
        content: `element.innerHTML = userInput;`,
        toolName: "write_file",
      };
      const result = analyzeFileWrite(event);
      expect(result.triggered).toBe(true);
      expect(
        result.warnings!.some((w) => w.includes("innerHTML")),
      ).toBe(true);
    });

    it("does not flag innerHTML with sanitization", () => {
      const event: FileWriteEvent = {
        filePath: "src/components/RichText.tsx",
        content: `element.innerHTML = sanitize(userInput);`,
        toolName: "write_file",
      };
      const result = analyzeFileWrite(event);
      expect(
        result.warnings?.some((w) => w.includes("innerHTML")),
      ).toBeFalsy();
    });

    it("detects @ts-ignore", () => {
      const event: FileWriteEvent = {
        filePath: "src/legacy/old.ts",
        content: `// @ts-ignore\nconst x: string = 123;`,
        toolName: "search_replace",
      };
      const result = analyzeFileWrite(event);
      expect(result.triggered).toBe(true);
      expect(
        result.warnings!.some((w) => w.includes("@ts-ignore")),
      ).toBe(true);
    });

    it("detects empty catch blocks", () => {
      const event: FileWriteEvent = {
        filePath: "src/handlers/api.ts",
        content: `try { fetch(url); } catch (e) {}`,
        toolName: "write_file",
      };
      const result = analyzeFileWrite(event);
      expect(result.triggered).toBe(true);
      expect(
        result.warnings!.some((w) => w.includes("Empty catch")),
      ).toBe(true);
    });

    it("skips non-TypeScript files for type warnings", () => {
      const event: FileWriteEvent = {
        filePath: "styles/main.css",
        content: `.button { color: any; }`,
        toolName: "write_file",
      };
      const result = analyzeFileWrite(event);
      // CSS files should not trigger TypeScript-specific warnings
      expect(
        result.warnings?.some((w) => w.includes("type check")),
      ).toBeFalsy();
    });
  });

  describe("shouldAutoTypeCheck", () => {
    it("returns true when 3+ TypeScript files edited", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 1, search_replace: 0 }],
        ["src/b.tsx", { write_file: 1, search_replace: 0 }],
        ["src/c.ts", { write_file: 1, search_replace: 0 }],
      ]);
      expect(shouldAutoTypeCheck(edits)).toBe(true);
    });

    it("returns false when fewer than 3 TypeScript files edited", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 1, search_replace: 0 }],
        ["src/b.tsx", { write_file: 1, search_replace: 0 }],
      ]);
      expect(shouldAutoTypeCheck(edits)).toBe(false);
    });

    it("ignores test files", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 1, search_replace: 0 }],
        ["src/b.test.ts", { write_file: 1, search_replace: 0 }],
        ["src/c.spec.ts", { write_file: 1, search_replace: 0 }],
      ]);
      expect(shouldAutoTypeCheck(edits)).toBe(false);
    });
  });

  describe("shouldAutoVibeScan", () => {
    it("returns true when 5+ files edited", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 2, search_replace: 1 }],
        ["src/b.ts", { write_file: 1, search_replace: 0 }],
        ["src/c.ts", { write_file: 1, search_replace: 0 }],
      ]);
      expect(shouldAutoVibeScan(edits)).toBe(true);
    });

    it("returns false when fewer than 5 edits", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 1, search_replace: 0 }],
        ["src/b.ts", { write_file: 1, search_replace: 0 }],
      ]);
      expect(shouldAutoVibeScan(edits)).toBe(false);
    });
  });

  describe("buildProactiveMessage", () => {
    it("returns null for clean files", () => {
      const event: FileWriteEvent = {
        filePath: "src/App.tsx",
        content: `export const App = () => <div>Hello</div>;`,
        toolName: "write_file",
      };
      const ctx = {} as any;
      expect(buildProactiveMessage(event, ctx)).toBeNull();
    });

    it("returns a message for files with issues", () => {
      const event: FileWriteEvent = {
        filePath: "src/bad.ts",
        content: `eval("bad");`,
        toolName: "write_file",
      };
      const ctx = {} as any;
      const msg = buildProactiveMessage(event, ctx);
      expect(msg).toContain("Auto-detected");
      expect(msg).toContain("eval()");
    });
  });

  describe("collectTurnTriggers", () => {
    it("returns empty when no significant edits", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 1, search_replace: 0 }],
      ]);
      const result = collectTurnTriggers(edits);
      expect(result.typeCheck).toBe(false);
      expect(result.vibeScan).toBe(false);
      expect(result.summary).toHaveLength(0);
    });

    it("triggers type check for 3+ TS files", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 1, search_replace: 0 }],
        ["src/b.ts", { write_file: 1, search_replace: 0 }],
        ["src/c.ts", { write_file: 1, search_replace: 0 }],
      ]);
      const result = collectTurnTriggers(edits);
      expect(result.typeCheck).toBe(true);
      expect(result.summary.some((s) => s.includes("TypeScript"))).toBe(true);
    });

    it("triggers vibe scan for 5+ total edits", () => {
      const edits = new Map([
        ["src/a.ts", { write_file: 2, search_replace: 1 }],
        ["src/b.ts", { write_file: 1, search_replace: 0 }],
        ["src/c.ts", { write_file: 1, search_replace: 0 }],
      ]);
      const result = collectTurnTriggers(edits);
      expect(result.vibeScan).toBe(true);
    });
  });
});
