import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { walkCodebase, summarizeFiles, collectTargetFiles } from "./codebase_walker";

const TEST_DIR = join(import.meta.dirname, "__test_walker_tmp__");

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await mkdir(join(TEST_DIR, "src"), { recursive: true });
  await mkdir(join(TEST_DIR, "node_modules", "pkg"), { recursive: true });

  await writeFile(join(TEST_DIR, "src", "app.ts"), 'export const App = "hello";\n');
  await writeFile(join(TEST_DIR, "src", "utils.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  await writeFile(join(TEST_DIR, "src", "styles.css"), ".root { color: red; }\n");
  await writeFile(join(TEST_DIR, "package.json"), '{"name":"test"}\n');
  // This file should be excluded by default (node_modules)
  await writeFile(join(TEST_DIR, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("codebase_walker", () => {
  describe("walkCodebase", () => {
    it("collects files from a directory", async () => {
      const files = await walkCodebase(TEST_DIR);
      const paths = files.map((f) => f.path).sort();
      expect(paths).toContain("src/app.ts");
      expect(paths).toContain("src/utils.ts");
      expect(paths).toContain("src/styles.css");
      expect(paths).toContain("package.json");
    });

    it("excludes node_modules by default", async () => {
      const files = await walkCodebase(TEST_DIR);
      expect(files.every((f) => !f.path.includes("node_modules"))).toBe(true);
    });

    it("respects extension filter", async () => {
      const files = await walkCodebase(TEST_DIR, {
        extensions: new Set([".ts"]),
      });
      expect(files.every((f) => f.path.endsWith(".ts"))).toBe(true);
    });

    it("respects limit parameter", async () => {
      const files = await walkCodebase(TEST_DIR, { limit: 2 });
      expect(files.length).toBeLessThanOrEqual(2);
    });

    it("includes lineCount for each file", async () => {
      const files = await walkCodebase(TEST_DIR);
      for (const f of files) {
        expect(f.lineCount).toBeGreaterThan(0);
      }
    });

    it("returns empty array for non-existent directory", async () => {
      const files = await walkCodebase("/nonexistent/path");
      expect(files).toHaveLength(0);
    });

    it("respects custom exclude set", async () => {
      const files = await walkCodebase(TEST_DIR, {
        exclude: new Set(["node_modules", ".git", "src"]),
      });
      expect(files.every((f) => !f.path.startsWith("src/"))).toBe(true);
    });
  });

  describe("summarizeFiles", () => {
    it("computes correct statistics", async () => {
      const files = await walkCodebase(TEST_DIR);
      const stats = summarizeFiles(files);
      expect(stats.totalFiles).toBeGreaterThan(0);
      expect(stats.totalLines).toBeGreaterThan(0);
      expect(stats.languages.length).toBeGreaterThan(0);
      expect(stats.extensions.size).toBeGreaterThan(0);
    });

    it("counts extensions correctly", async () => {
      const files = await walkCodebase(TEST_DIR, {
        extensions: new Set([".ts", ".css"]),
      });
      const stats = summarizeFiles(files);
      expect(stats.extensions.get(".ts")).toBe(2);
      expect(stats.extensions.get(".css")).toBe(1);
    });
  });

  describe("collectTargetFiles", () => {
    it("collects a single file", async () => {
      const files = await collectTargetFiles(
        join(TEST_DIR, "src", "app.ts"),
        "src/app.ts",
      );
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/app.ts");
      expect(files[0].content).toContain("hello");
    });

    it("collects files from a directory", async () => {
      const files = await collectTargetFiles(
        join(TEST_DIR, "src"),
        "src",
      );
      expect(files.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty for non-existent path", async () => {
      const files = await collectTargetFiles(
        "/nonexistent/path",
        "nonexistent",
      );
      expect(files).toHaveLength(0);
    });
  });
});
