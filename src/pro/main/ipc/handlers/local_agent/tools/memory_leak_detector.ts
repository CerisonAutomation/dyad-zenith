/**
 * memory_leak_detector.ts — Detects common memory leak patterns in code
 * (event listeners, timers, closures, caches, subscriptions).
 * Based on [$memory-leak-detection].
 */
import { z } from "zod";
import { readFile } from "fs/promises";
import { resolve, join, extname } from "path";
import { escapeXmlAttr, type ToolDefinition, type ToolResult } from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";

const INPUT_SCHEMA = z.object({
  path: z
    .string()
    .optional()
    .describe("File or directory to scan (defaults to src/)"),
  language: z
    .enum(["javascript", "typescript", "react", "auto"])
    .default("auto")
    .describe("Language context for pattern detection"),
});

type LeakPattern = {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  pattern: RegExp;
  description: string;
  fix: string;
};

const LEAK_PATTERNS: LeakPattern[] = [
  // Event listener leaks
  {
    id: "EL-001",
    severity: "high",
    category: "event_listener",
    pattern:
      /addEventListener\s*\(\s*['"][^'"]+['"]\s*,\s*(?!.*removeEventListener)/g,
    description:
      "addEventListener without corresponding removeEventListener detected",
    fix: "Ensure cleanup in useEffect return, componentWillUnmount, or destroy() method",
  },
  {
    id: "EL-002",
    severity: "high",
    category: "event_listener",
    pattern: /\bon\(\s*['"][^'"]+['"]\s*,\s*(?!.*off\()/g,
    description: "Event emitter .on() without corresponding .off() detected",
    fix: "Store handler reference and call .off() in cleanup function",
  },

  // Timer leaks
  {
    id: "TM-001",
    severity: "high",
    category: "timer",
    pattern: /setInterval\s*\((?!.*clearInterval)/g,
    description: "setInterval without corresponding clearInterval",
    fix: "Store interval ID and clearInterval in cleanup function",
  },
  {
    id: "TM-002",
    severity: "medium",
    category: "timer",
    pattern: /setTimeout\s*\((?!.*clearTimeout)/g,
    description: "setTimeout without clearTimeout guard",
    fix: "If component may unmount before timeout fires, store and clear the ID",
  },

  // Subscription leaks
  {
    id: "SUB-001",
    severity: "critical",
    category: "subscription",
    pattern: /\.subscribe\((?!.*\.unsubscribe|unsubscribe\s*[=;])/g,
    description: "Observable subscription without unsubscribe",
    fix: "Store subscription and call .unsubscribe() in cleanup",
  },
  {
    id: "SUB-002",
    severity: "high",
    category: "subscription",
    pattern: /onSnapshot\s*\((?!.*unsubscribe)/g,
    description: "Firestore onSnapshot without unsubscribe",
    fix: "Store unsubscribe function from onSnapshot and call it in cleanup",
  },
  {
    id: "SUB-003",
    severity: "high",
    category: "subscription",
    pattern: /addEventListener\s*\(\s*['"]message['"]/g,
    description:
      "WebSocket/MessagePort message listener — verify cleanup on close",
    fix: "Remove listener before closing connection",
  },

  // Cache/Map leaks
  {
    id: "CH-001",
    severity: "medium",
    category: "cache",
    pattern: /new Map\(\)|new Set\(\)/g,
    description: "Map/Set created — verify it has cleanup/expiry mechanism",
    fix: "Add size limit, LRU eviction, or clear on component unmount",
  },
  {
    id: "CH-002",
    severity: "medium",
    category: "cache",
    pattern: /new WeakMap\(\)|new WeakSet\(\)/g,
    description:
      "WeakMap/WeakSet created — good for preventing leaks, verify usage",
    fix: "WeakMap/WeakSet are auto-cleaned, verify entries aren't accidentally strong-referenced elsewhere",
  },

  // Closure leaks
  {
    id: "CL-001",
    severity: "high",
    category: "closure",
    pattern: /useEffect\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?function\s+\w+[\s\S]*?\}/g,
    description:
      "useEffect with nested function captures — verify no stale closures",
    fix: "Use useEffectEvent (React 19) or ensure deps array is correct",
  },
  {
    id: "CL-002",
    severity: "medium",
    category: "closure",
    pattern:
      /new Promise\s*\(\s*(?:async\s*)?\([\s\S]*?resolve[\s\S]*?\)\s*\)/g,
    description:
      "Promise with captured scope — verify it resolves/rejects (hanging promises hold memory)",
    fix: "Ensure all promises resolve; use AbortController for cancellable async",
  },

  // React-specific leaks
  {
    id: "RCT-001",
    severity: "high",
    category: "react",
    pattern: /useRef\(\s*\{\s*\}\s*\)[\s\S]*?\.current\s*=/g,
    description: "useRef with mutable object — verify cleanup on unmount",
    fix: "Clear ref.current in useEffect cleanup or use WeakRef",
  },
  {
    id: "RCT-002",
    severity: "medium",
    category: "react",
    pattern: /useEffect\s*\(\s*\(\)\s*=>\s*\{\s*\}/g,
    description:
      "Empty useEffect — may be missing cleanup for setup side effects",
    fix: "If effect sets up listeners/subscriptions, return cleanup function",
  },
];

function detectLeaks(code: string): { pattern: LeakPattern; line: number }[] {
  const findings: { pattern: LeakPattern; line: number }[] = [];
  const lines = code.split("\n");

  for (const pattern of LEAK_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      pattern.pattern.lastIndex = 0;
      if (pattern.pattern.test(line)) {
        findings.push({ pattern, line: i + 1 });
      }
    }
  }

  return findings;
}

export const memoryLeakDetectorTool: ToolDefinition<
  z.infer<typeof INPUT_SCHEMA>
> = {
  name: "memory_leak_detector",
  description:
    "Scan code for memory leak patterns: event listeners, timers, subscriptions, caches, closures.",
  inputSchema: INPUT_SCHEMA,
  defaultConsent: "always",

  isEnabled: () => true,

  getConsentPreview(input) {
    return `🔍 Memory leak detection on: ${input.path || "src/"}`;
  },

  buildXml(input, _isComplete) {
    return `<memory_leak_detector path="${escapeXmlAttr(input.path || "src/")}" language="${escapeXmlAttr(input.language)}" />`;
  },

  async execute(input, ctx): Promise<ToolResult> {
    const targetPath = input.path
      ? safeJoin(ctx.appPath, input.path)
      : resolve(ctx.appPath, "src");

    ctx.onXmlStream?.(`🔍 Scanning for memory leak patterns...\n`);

    let files: string[] = [];
    try {
      const { readdir, stat } = await import("fs/promises");
      const { extname, join } = await import("path");
      const codeExts = new Set([
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".vue",
        ".svelte",
      ]);
      const s = await stat(targetPath);

      if (s.isFile()) {
        files = [targetPath];
      } else {
        const collect = async (
          dir: string,
          depth: number,
        ): Promise<string[]> => {
          if (depth > 5) return [];
          const results: string[] = [];
          for (const entry of await readdir(dir)) {
            if (
              entry === "node_modules" ||
              entry === ".git" ||
              entry === "dist"
            )
              continue;
            const fp = join(dir, entry);
            const st = await stat(fp);
            if (st.isDirectory())
              results.push(...(await collect(fp, depth + 1)));
            else if (codeExts.has(extname(entry).toLowerCase()))
              results.push(fp);
          }
          return results;
        };
        files = await collect(targetPath, 0);
      }
    } catch {
      return `Path not found: ${targetPath}`;
    }

    const allFindings: { file: string; pattern: LeakPattern; line: number }[] =
      [];

    for (const filePath of files) {
      try {
        const code = await readFile(filePath, "utf-8");
        const findings = detectLeaks(code);
        for (const f of findings) {
          allFindings.push({
            file: filePath.replace(ctx.appPath + "/", ""),
            pattern: f.pattern,
            line: f.line,
          });
        }
      } catch {
        // Skip unreadable
      }
    }

    // Deduplicate by pattern+file
    const seen = new Set<string>();
    const unique = allFindings.filter((f) => {
      const key = `${f.pattern.id}:${f.file}:${f.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const bySeverity = {
      critical: unique.filter((f) => f.pattern.severity === "critical"),
      high: unique.filter((f) => f.pattern.severity === "high"),
      medium: unique.filter((f) => f.pattern.severity === "medium"),
      low: unique.filter((f) => f.pattern.severity === "low"),
    };

    const byCategory: Record<string, number> = {};
    for (const f of unique) {
      byCategory[f.pattern.category] =
        (byCategory[f.pattern.category] || 0) + 1;
    }

    ctx.onXmlComplete?.(
      `🔍 Memory Leak Detection Results\n\n` +
        `📊 ${unique.length} potential issues across ${files.length} files\n\n` +
        `🔴 Critical: ${bySeverity.critical.length} | 🟡 High: ${bySeverity.high.length} | 🔵 Medium: ${bySeverity.medium.length} | ⚪ Low: ${bySeverity.low.length}\n\n` +
        `By category: ${Object.entries(byCategory)
          .map(([k, v]) => `${k}(${v})`)
          .join(", ")}\n\n` +
        unique
          .slice(0, 15)
          .map(
            (f) =>
              `[${f.pattern.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.pattern.id}\n  ${f.pattern.description}\n  Fix: ${f.pattern.fix}`,
          )
          .join("\n\n"),
    );

    return `Memory leak scan complete: ${unique.length} potential issues (${bySeverity.critical.length} critical, ${bySeverity.high.length} high). Categories: ${Object.entries(
      byCategory,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}.`;
  },
};
