/**
 * webapp_tester.ts — Analyzes web app test infrastructure, detects anti-patterns,
 * validates Playwright config, checks accessibility setup, and generates test scaffolding.
 * Based on [$webapp-testing], [$web-development], [$web-design-guidelines].
 */
import { z } from "zod";
import log from "electron-log";
import { readFile, readdir, stat, writeFile, mkdir } from "fs/promises";
import { join, relative } from "path";
import { escapeXmlAttr, escapeXmlContent, type ToolDefinition } from "./types";

const logger = log.scope("webapp_tester");

// ============================================================================
// Schema
// ============================================================================

const webappTesterSchema = z.object({
  mode: z
    .enum([
      "analyze",
      "generate_config",
      "scaffold_tests",
      "anti_patterns",
      "accessibility_audit",
      "full_audit",
    ])
    .default("full_audit")
    .describe(
      "analyze: audit existing test infra; generate_config: create playwright.config.ts; scaffold_tests: generate test skeletons; anti_patterns: detect bad testing patterns; accessibility_audit: check a11y test coverage; full_audit: all of the above",
    ),
  target_dir: z
    .string()
    .optional()
    .describe("Directory to scan (defaults to src/ or root)"),
  page_urls: z
    .array(z.string())
    .optional()
    .describe(
      "URLs to test (e.g. ['/', '/login', '/dashboard']). Used by scaffold_tests.",
    ),
  focus: z
    .enum(["all", "unit", "integration", "e2e", "a11y", "visual"])
    .default("all")
    .describe("Test type to focus on"),
});

// ============================================================================
// Anti-pattern definitions
// ============================================================================

interface AntiPattern {
  id: string;
  severity: "critical" | "major" | "minor";
  category: string;
  pattern: RegExp;
  description: string;
  fix: string;
}

const TEST_ANTI_PATTERNS: AntiPattern[] = [
  // Playwright-specific
  {
    id: "PW-001",
    severity: "critical",
    category: "playwright",
    pattern: /waitForTimeout\s*\(\s*\d+/g,
    description: "Hardcoded page.waitForTimeout() — flaky and slow",
    fix: "Replace with page.waitForSelector(), page.waitForLoadState(), or expect(locator).toBeVisible()",
  },
  {
    id: "PW-002",
    severity: "major",
    category: "playwright",
    pattern: /page\.(click|fill|type)\s*\(\s*['"][^'"]*['"]\s*\)/g,
    description:
      "Selector-based interaction without locator — fragile to DOM changes",
    fix: "Use page.getByRole(), page.getByText(), page.getByTestId() instead of raw CSS/XPath selectors",
  },
  {
    id: "PW-003",
    severity: "major",
    category: "playwright",
    pattern: /page\.(goto|waitForNavigation)/g,
    description:
      "Navigation without waitForLoadState — race conditions possible",
    fix: "Chain .then() or use await page.waitForLoadState('networkidle') after navigation",
  },
  {
    id: "PW-004",
    severity: "minor",
    category: "playwright",
    pattern: /expect\s*\(\s*await\s+page[^)]+\)\.toBe/g,
    description:
      "Asserting page content directly — use locator assertions for auto-waiting",
    fix: "Use expect(page.getByRole(...)).toBeVisible() or expect(locator).toHaveText()",
  },

  // General test anti-patterns
  {
    id: "TST-001",
    severity: "critical",
    category: "general",
    pattern:
      /(?:test|it)\s*\(\s*['"][^'"]*['"][^)]*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[^}]*\b(?:fetch|axios|http)\b/gs,
    description: "Test makes real HTTP calls — should use MSW or API mocking",
    fix: "Use msw (Mock Service Worker) or vi.mock() to intercept network requests",
  },
  {
    id: "TST-002",
    severity: "major",
    category: "general",
    pattern:
      /(?:test|it)\s*\(\s*['"][^'"]*['"][^)]*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[\s\S]{500,}?\}\s*\)/g,
    description:
      "Test body exceeds 500 characters — likely testing too many things",
    fix: "Split into focused tests; each test should verify one behavior (AAA pattern)",
  },
  {
    id: "TST-003",
    severity: "major",
    category: "general",
    pattern:
      /(?:test|it|describe)\s*\(\s*['"][^'"]*(?:should work|should be|does stuff|works)[^'"]*['"]/g,
    description: "Vague test name — doesn't describe the behavior being tested",
    fix: "Use descriptive names: 'returns 401 when token is expired', 'displays error for empty form'",
  },
  {
    id: "TST-004",
    severity: "minor",
    category: "general",
    pattern:
      /(?:beforeEach|beforeAll)\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[^}]*\b(?:db\.|mysql|postgres|mongo)\b/gs,
    description:
      "Direct database calls in test setup — use test fixtures or factories",
    fix: "Use test database with factories/fixtures; avoid touching real DB in unit tests",
  },
  {
    id: "TST-005",
    severity: "minor",
    category: "general",
    pattern: /console\.(log|warn|error)\s*\(/g,
    description: "Console output in tests — clutters test runner output",
    fix: "Remove or use a test-specific logger; vi.spyOn(console, 'log').mockImplementation()",
  },

  // Component test anti-patterns
  {
    id: "CMP-001",
    severity: "major",
    category: "component",
    pattern: /getByTestId\s*\(\s*['"][^'"]*['"]\s*\)/g,
    description: "Over-reliance on data-testid — prefer semantic queries",
    fix: "Use getByRole(), getByLabelText(), getByText() first; reserve data-testid for last resort",
  },
  {
    id: "CMP-002",
    severity: "minor",
    category: "component",
    pattern: /wrapper\s*\.\s*(?:find|findComponent)\s*\(/g,
    description:
      "Deep component tree traversal in tests — brittle to implementation changes",
    fix: "Test from the user's perspective: what they see and interact with, not internal structure",
  },

  // Snapshot anti-patterns
  {
    id: "SNP-001",
    severity: "minor",
    category: "snapshot",
    pattern: /toMatchSnapshot\s*\(\s*\)/g,
    description: "Blanket snapshot test — snapshots can mask real issues",
    fix: "Use toMatchInlineSnapshot() for small values; snapshot only layout structure, not data",
  },
];

// ============================================================================
// Playwright config generator
// ============================================================================

const PLAYWRIGHT_CONFIG_TEMPLATE = (
  appName: string,
) => `import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for ${appName}
 * Generated by Dyad webapp_tester
 *
 * BASE_URL defaults to Dyad's preview proxy — the same URL shown in the
 * Dyad preview panel. Override by setting BASE_URL in the environment or
 * by running: BASE_URL=http://localhost:5173 npx playwright test
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["html", { open: "never" }],
    ["list"],
  ],
  use: {
    // Dyad runs a local proxy for each app — its URL is in the Dyad preview panel.
    // Set BASE_URL to override (e.g. http://localhost:3000 for Vite default).
    baseURL: process.env.BASE_URL || process.env.DYAD_TEST_BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 13"] },
    },
  ],
  // Dyad starts the dev server separately — reuseExistingServer picks it up.
  webServer: {
    command: process.env.CI ? "" : "npm run dev",
    url: process.env.BASE_URL || process.env.DYAD_TEST_BASE_URL || "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
`;

const TEST_SKELETON_TEMPLATE = (
  url: string,
  name: string,
) => `import { test, expect } from "@playwright/test";

test.describe("${name}", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("${url}");
  });

  test("loads successfully", async ({ page }) => {
    await expect(page).toHaveTitle(/.+/);
  });

  test("is accessible", async ({ page }) => {
    // Run axe accessibility scan
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test("has no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.reload();
    await page.waitForLoadState("networkidle");

    expect(errors).toEqual([]);
  });
});
`;

// ============================================================================
// Helpers
// ============================================================================

interface TestFile {
  path: string;
  relativePath: string;
  content: string;
}

async function collectTestFiles(
  dir: string,
  maxDepth = 4,
  depth = 0,
): Promise<TestFile[]> {
  if (depth > maxDepth) return [];
  const results: TestFile[] = [];
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (["node_modules", ".git", "dist", "build", ".next"].includes(entry))
        continue;
      const fullPath = join(dir, entry);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        results.push(
          ...(await collectTestFiles(fullPath, maxDepth, depth + 1)),
        );
      } else if (
        /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry) ||
        entry === "playwright.config.ts" ||
        entry === "playwright.config.js"
      ) {
        const content = await readFile(fullPath, "utf-8");
        results.push({ path: fullPath, relativePath: fullPath, content });
      }
    }
  } catch {
    // Permission error
  }
  return results;
}

async function collectSourceFiles(
  dir: string,
  maxDepth = 3,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (
        [
          "node_modules",
          ".git",
          "dist",
          "build",
          ".next",
          "__tests__",
          "tests",
        ].includes(entry)
      )
        continue;
      const fullPath = join(dir, entry);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        results.push(
          ...(await collectSourceFiles(fullPath, maxDepth, depth + 1)),
        );
      } else if (
        /\.(tsx?|jsx?)$/.test(entry) &&
        !/\.(test|spec)\./.test(entry)
      ) {
        results.push(fullPath);
      }
    }
  } catch {
    // Permission error
  }
  return results;
}

function detectAntiPatterns(
  code: string,
  _filename: string,
): {
  id: string;
  severity: string;
  category: string;
  description: string;
  fix: string;
  line?: number;
}[] {
  const findings: {
    id: string;
    severity: string;
    category: string;
    description: string;
    fix: string;
    line?: number;
  }[] = [];
  const lines = code.split("\n");

  for (const ap of TEST_ANTI_PATTERNS) {
    // Reset regex lastIndex for each pattern
    ap.pattern.lastIndex = 0;

    if (ap.pattern.source.includes("[\\s\\S]")) {
      // Multi-line pattern — match on full code
      const match = ap.pattern.exec(code);
      if (match) {
        const beforeMatch = code.slice(0, match.index);
        const lineNum = beforeMatch.split("\n").length;
        findings.push({ ...ap, line: lineNum });
      }
    } else {
      // Line-by-line pattern
      for (let i = 0; i < lines.length; i++) {
        ap.pattern.lastIndex = 0;
        if (ap.pattern.test(lines[i])) {
          findings.push({ ...ap, line: i + 1 });
          break; // One finding per pattern per file
        }
      }
    }
  }

  return findings;
}

function assessTestCoverage(
  sourceFiles: string[],
  testFiles: TestFile[],
): { covered: string[]; uncovered: string[]; coveragePercent: number } {
  const sourceBasenames = sourceFiles.map((f) => {
    const parts = f.split("/");
    return parts[parts.length - 1].replace(/\.(tsx?|jsx?)$/, "");
  });

  const testBasenames = new Set(
    testFiles.map((t) => {
      const parts = t.relativePath.split("/");
      return parts[parts.length - 1].replace(/\.(test|spec)\.(tsx?|jsx?)$/, "");
    }),
  );

  const covered = sourceBasenames.filter((s) => testBasenames.has(s));
  const uncovered = sourceBasenames.filter((s) => !testBasenames.has(s));

  return {
    covered,
    uncovered,
    coveragePercent:
      sourceBasenames.length > 0
        ? Math.round((covered.length / sourceBasenames.length) * 100)
        : 0,
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const webappTesterTool: ToolDefinition<
  z.infer<typeof webappTesterSchema>
> = {
  name: "webapp_tester",
  description:
    "Analyze web app test infrastructure: detect Playwright anti-patterns (waitForTimeout, selector-based locators), audit accessibility test coverage, assess test coverage vs source files, generate Playwright config and test skeletons.",
  inputSchema: webappTesterSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => {
    return `🧪 WebApp Tester — mode=${args.mode}, focus=${args.focus}`;
  },

  buildXml: (args) => {
    return [
      `<webapp_tester mode="${escapeXmlAttr(args.mode)}" focus="${escapeXmlAttr(args.focus)}">`,
      args.target_dir
        ? `<target_dir>${escapeXmlContent(args.target_dir)}</target_dir>`
        : "",
      args.page_urls
        ? `<urls>${args.page_urls.map((u) => `<url>${escapeXmlContent(u)}</url>`).join("")}</urls>`
        : "",
      `</webapp_tester>`,
    ].join("\n");
  },

  execute: async (args, ctx) => {
    ctx.abortSignal?.throwIfAborted();
    const mode = args.mode || "full_audit";
    const focus = args.focus || "all";

    logger.log(`Executing webapp_tester: mode=${mode}, focus=${focus}`);
    ctx.abortSignal?.throwIfAborted();

    const scanDir = args.target_dir
      ? join(ctx.appPath, args.target_dir)
      : ctx.appPath;

    const output: string[] = [`# 🧪 WebApp Tester — ${mode}\n`];

    // ── Mode: generate_config ──
    if (mode === "generate_config" || mode === "full_audit") {
      const configPath = join(ctx.appPath, "playwright.config.ts");
      try {
        await stat(configPath);
        output.push("## Playwright Config");
        output.push(
          "✅ `playwright.config.ts` already exists — skipping generation.\n",
        );
      } catch {
        const appName = ctx.appPath.split("/").pop() || "app";
        const config = PLAYWRIGHT_CONFIG_TEMPLATE(appName);
        await writeFile(configPath, config, "utf-8");
        output.push("## Playwright Config");
        output.push(`✅ Generated \`playwright.config.ts\` with:`);
        output.push(
          `- 5 projects: Chromium, Firefox, WebKit, Mobile Chrome, Mobile Safari`,
        );
        output.push(`- HTML + list reporters`);
        output.push(`- Auto webServer for local dev`);
        output.push(`- CI-aware retries and workers\n`);
      }
    }

    // ── Mode: scaffold_tests ──
    if (mode === "scaffold_tests" || mode === "full_audit") {
      const urls = args.page_urls || ["/"];
      const testsDir = join(ctx.appPath, "tests");
      try {
        await stat(testsDir);
      } catch {
        await mkdir(testsDir, { recursive: true });
      }

      output.push("## Test Scaffolds");
      for (const url of urls) {
        const name =
          url === "/" ? "home" : url.replace(/^\//, "").replace(/\//g, "_");
        const testPath = join(testsDir, `${name}.spec.ts`);
        try {
          await stat(testPath);
          output.push(`- ⏭️ \`${name}.spec.ts\` already exists`);
        } catch {
          const skeleton = TEST_SKELETON_TEMPLATE(url, name);
          await writeFile(testPath, skeleton, "utf-8");
          output.push(`- ✅ Created \`${name}.spec.ts\` for \`${url}\``);
        }
      }
      output.push("");
    }

    // ── Collect test and source files ──
    ctx.abortSignal?.throwIfAborted();

    const testFiles = await collectTestFiles(scanDir);
    const sourceFiles = await collectSourceFiles(scanDir);

    // ── Mode: analyze / full_audit ──
    if (mode === "analyze" || mode === "full_audit") {
      output.push("## Test Infrastructure Analysis");
      output.push(`- **Test files found:** ${testFiles.length}`);
      output.push(`- **Source files found:** ${sourceFiles.length}`);

      if (testFiles.length === 0) {
        output.push(
          `- ⚠️ **No test files found** — run \`generate_config\` + \`scaffold_tests\` to bootstrap\n`,
        );
      } else {
        const coverage = assessTestCoverage(sourceFiles, testFiles);
        output.push(
          `- **Component coverage:** ${coverage.coveragePercent}% (${coverage.covered.length}/${sourceFiles.length} source files have matching tests)`,
        );

        if (coverage.uncovered.length > 0) {
          output.push(
            `- **Uncovered:** ${coverage.uncovered.slice(0, 15).join(", ")}${coverage.uncovered.length > 15 ? ` (+${coverage.uncovered.length - 15} more)` : ""}`,
          );
        }
        output.push("");
      }

      // Check for playwright config
      const hasPlaywright = testFiles.some((t) =>
        t.path.includes("playwright.config"),
      );
      output.push(
        `- **Playwright configured:** ${hasPlaywright ? "✅ Yes" : "❌ No"}`,
      );
      output.push("");
    }

    // ── Mode: anti_patterns / full_audit ──
    if (mode === "anti_patterns" || mode === "full_audit") {
      output.push("## Anti-Pattern Detection");
      let totalFindings = 0;

      for (const tf of testFiles) {
        const findings = detectAntiPatterns(tf.content, tf.path);
        if (findings.length > 0) {
          const relPath = tf.relativePath.replace(ctx.appPath + "/", "");
          output.push(`\n### ${relPath}`);
          for (const f of findings) {
            const lineStr = f.line ? `L${f.line}` : "?";
            output.push(
              `- [${f.severity.toUpperCase()}] **${f.id}** (${lineStr}): ${f.description}`,
            );
            output.push(`  → Fix: ${f.fix}`);
            totalFindings++;
          }
        }
      }

      if (totalFindings === 0) {
        output.push(
          testFiles.length > 0
            ? "✅ No anti-patterns detected in test files.\n"
            : "⚠️ No test files to analyze.\n",
        );
      } else {
        output.push(`\n**Total findings:** ${totalFindings}\n`);
      }
    }

    // ── Mode: accessibility_audit / full_audit ──
    if (mode === "accessibility_audit" || mode === "full_audit") {
      output.push("## Accessibility Test Coverage");

      // Check if axe-core is installed
      let hasAxe = false;
      try {
        const pkgPath = join(ctx.appPath, "package.json");
        const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        hasAxe = !!(
          allDeps["@axe-core/playwright"] ||
          allDeps["axe-core"] ||
          allDeps["@axe-core/react"]
        );
      } catch {
        // No package.json
      }

      output.push(
        `- **axe-core installed:** ${hasAxe ? "✅ Yes" : "❌ No — run `npm i -D @axe-core/playwright`"}`,
      );

      // Check for a11y in test files
      let a11yTestCount = 0;
      for (const tf of testFiles) {
        if (/axe|a11y|accessibility|wcag|aria|getByRole/i.test(tf.content)) {
          a11yTestCount++;
        }
      }
      output.push(
        `- **Tests with a11y checks:** ${a11yTestCount}/${testFiles.length}`,
      );
      output.push(
        `- **Expected:** All page-level E2E tests should include axe scan`,
      );
      output.push("");
    }

    // ── Summary ──
    output.push("---");
    output.push(
      `**Scanned:** ${relative(ctx.appPath, scanDir) || "."} | **Tests:** ${testFiles.length} | **Sources:** ${sourceFiles.length}`,
    );

    const result = output.join("\n");
    ctx.onXmlComplete?.(result);
    return result;
  },
};
