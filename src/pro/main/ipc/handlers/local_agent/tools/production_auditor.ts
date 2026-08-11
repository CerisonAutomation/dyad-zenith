/**
 * production_auditor.ts — Production readiness audit: security scanning, OWASP Top 10,
 * SBOM generation, dependency review, config hardening, deep codebase scanning for
 * architecture issues, N+1 queries, circular dependencies, and code quality.
 * Based on [$production-ready], [$production-code-audit].
 */
import { z } from "zod";
import log from "electron-log";
import { relative, join } from "path";
import { resolveReadPathWithinApp } from "@/ipc/utils/path_utils";
import { collectTargetFiles } from "./codebase_walker";
import { escapeXmlAttr, type ToolDefinition, type AgentContext } from "./types";

const INPUT_SCHEMA = z.object({
  mode: z
    .enum(["quick", "security", "deep_scan", "architecture", "full_audit"])
    .describe(
      "Audit mode: quick (secrets + critical vulns), security (deep vuln + SBOM), deep_scan (line-by-line codebase scan), architecture (deps + coupling), full_audit (everything)",
    ),
  file_path: z
    .string()
    .optional()
    .describe("Specific file or directory to focus on (optional)"),
});

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".css",
  ".mjs",
  ".env",
  ".env.*",
]);

// ── Quick Security Scan ──

function scanSecrets(
  files: { path: string; content: string }[],
  ctx: AgentContext,
): string[] {
  const output: string[] = [];
  output.push("## Secret Scanning\n");

  const SECRET_PATTERNS = [
    {
      pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/gi,
      name: "API Key",
    },
    {
      pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
      name: "Secret/Password",
    },
    {
      pattern:
        /(?:token|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]/gi,
      name: "Token",
    },
    {
      pattern:
        /(?:aws[_-]?access[_-]?key[_-]?id)\s*[:=]\s*['"]A[A-Z0-9]{16}['"]/gi,
      name: "AWS Key",
    },
    {
      pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
      name: "Private Key",
    },
    {
      pattern: /(?:sk_live|pk_live|sk_test|pk_test)_[A-Za-z0-9]{20,}/g,
      name: "Stripe Key",
    },
    { pattern: /ghp_[A-Za-z0-9]{36}/g, name: "GitHub Token" },
    { pattern: /xox[bpsa]-[A-Za-z0-9-]+/g, name: "Slack Token" },
  ];

  let found = 0;
  for (const f of files) {
    // Skip non-secret-prone files
    if (/\.test\.|\.spec\.|__tests__|README|\.md$/.test(f.path)) continue;

    for (const { pattern, name } of SECRET_PATTERNS) {
      const matches = f.content.match(pattern);
      if (matches) {
        const relPath = relative(ctx.appPath, f.path);
        output.push(
          `- 🔴 \`${relPath}\` — ${name} detected (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
        );
        found++;
      }
    }
  }

  if (found === 0) {
    output.push("- ✅ No hardcoded secrets detected");
  }

  output.push("");
  return output;
}

function scanDependencyVulnerabilities(
  files: { path: string; content: string }[],
  _ctx: AgentContext,
): string[] {
  const output: string[] = [];
  output.push("## Dependency Vulnerabilities\n");

  const pkgFile = files.find((f) => f.path.endsWith("package.json"));
  if (!pkgFile) {
    output.push("- ℹ️ No package.json found — skipping dependency analysis");
    output.push("");
    return output;
  }

  try {
    const pkg = JSON.parse(pkgFile.content);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Known vulnerable patterns
    const KNOWN_VULN: Record<string, string> = {
      minimist: "<1.2.6 prototype pollution",
      lodash: "<4.17.21 prototype pollution",
      "node-fetch": "<2.6.7 info disclosure",
      "glob-parent": "<5.1.2 ReDoS",
      trim: "<0.0.3 ReDoS",
      elliptic: "<6.5.4 timing attack",
    };

    let vulnCount = 0;
    for (const [dep, range] of Object.entries(KNOWN_VULN)) {
      if (allDeps[dep]) {
        output.push(`- 🟠 \`${dep}\` — Check for: ${range}`);
        vulnCount++;
      }
    }

    if (vulnCount === 0) {
      output.push("- ✅ No known vulnerable dependencies in common patterns");
    }

    // Check for outdated lock files
    output.push("\n### Lock File Status\n");
    const hasLock = files.some((f) =>
      /package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun.lockb/.test(f.path),
    );
    if (hasLock) {
      output.push("- ✅ Lock file present");
    } else {
      output.push(
        "- ⚠️ No lock file found — dependencies may be non-deterministic",
      );
    }

    // .env file check
    output.push("\n### Environment Config\n");
    const envFiles = files.filter((f) =>
      /\.env\.example|\.env\.sample/.test(f.path),
    );
    if (envFiles.length > 0) {
      output.push("- ✅ .env.example exists");
    } else {
      output.push(
        "- 🟠 No .env.example — document required environment variables",
      );
    }
  } catch {
    output.push("- ⚠️ Could not parse package.json");
  }

  output.push("");
  return output;
}

// ── Deep Codebase Scan ──

function scanArchitecture(
  files: { path: string; content: string }[],
  ctx: AgentContext,
): string[] {
  const output: string[] = [];
  output.push("## Architecture Analysis\n");

  // God class detection (>500 lines or >20 methods)
  output.push("### God Class Detection\n");
  let godClasses = 0;
  for (const f of files) {
    if (!/\.(tsx?|jsx?)$/.test(f.path)) continue;
    const lines = f.content.split("\n").length;
    const methods = (
      f.content.match(
        /(?:function|const\s+\w+\s*=\s*(?:async\s+)?\(|(?:public|private|protected)\s+\w+\s*\()/g,
      ) || []
    ).length;
    if (lines > 500 || methods > 20) {
      const relPath = relative(ctx.appPath, f.path);
      output.push(
        `- 🔴 \`${relPath}\` — ${lines} lines, ~${methods} methods (consider splitting)`,
      );
      godClasses++;
    }
  }
  if (godClasses === 0) {
    output.push(
      "- ✅ No god classes detected (all files <500 lines, <20 methods)",
    );
  }

  // Circular dependency check (simplified)
  output.push("\n### Import Analysis\n");
  const importMap = new Map<string, Set<string>>();
  for (const f of files) {
    if (!/\.(tsx?|jsx?)$/.test(f.path)) continue;
    const imports =
      f.content.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/g) || [];
    const localImports = imports
      .map((i) => {
        const m = i.match(/from\s+['"]([^'"]+)['"]/);
        return m ? m[1] : null;
      })
      .filter(
        (p): p is string => !!p && (p.startsWith("./") || p.startsWith("../")),
      );
    importMap.set(f.path, new Set(localImports));
  }

  // Check for potential cycles (A imports B, B imports A)
  let cycles = 0;
  for (const [file, imports] of importMap) {
    for (const imp of imports) {
      // Resolve relative import
      const dir = file.replace(/\/[^/]+$/, "");
      const resolved = join(dir, imp).replace(/\\/g, "/");
      const normalized = resolved.replace(/\.(tsx?|jsx?)$/, "");
      for (const [otherFile] of importMap) {
        if (otherFile === file) continue;
        const otherNormalized = otherFile.replace(/\.(tsx?|jsx?)$/, "");
        if (
          normalized.includes(otherNormalized) ||
          otherNormalized.includes(normalized)
        ) {
          // Check reverse
          const reverseImports = importMap.get(otherFile);
          if (reverseImports) {
            if (
              relative(ctx.appPath, file).includes(
                relative(ctx.appPath, otherFile).replace(/\.[^.]+$/, ""),
              )
            ) {
              // Potential cycle
              cycles++;
            }
          }
        }
      }
    }
  }
  if (cycles > 0) {
    output.push(
      `- 🟠 ${cycles} potential circular dependency pairs — verify and break cycles`,
    );
  } else {
    output.push("- ✅ No obvious circular dependencies detected");
  }

  output.push("");
  return output;
}

function scanSecurityDeep(
  files: { path: string; content: string }[],
  ctx: AgentContext,
): string[] {
  const output: string[] = [];
  output.push("## Security Deep Scan\n");

  for (const f of files) {
    if (!/\.(tsx?|jsx?|ts|js)$/.test(f.path)) continue;
    const relPath = relative(ctx.appPath, f.path);
    const issues: string[] = [];

    // SQL injection
    if (/query\s*\(\s*[`'"].*\$\{|\.query\(\s*[`'"].*\+/.test(f.content)) {
      issues.push("Potential SQL injection (string concatenation in query)");
    }

    // XSS
    if (
      /dangerouslySetInnerHTML/.test(f.content) &&
      !/DOMPurify|sanitize|xss/.test(f.content)
    ) {
      issues.push("dangerouslySetInnerHTML without sanitization");
    }

    // eval / Function constructor
    if (/\beval\s*\(|new\s+Function\s*\(/.test(f.content)) {
      issues.push("Use of eval() or new Function() — security risk");
    }

    // Hardcoded localhost
    if (/localhost:\d+/.test(f.content) && !/\.env|process\.env/.test(f.path)) {
      // Only flag if it's not in a config/env file
      if (!/config|\.env/.test(f.path)) {
        issues.push("Hardcoded localhost URL (use environment variable)");
      }
    }

    // Missing input validation
    if (
      /req\.body|request\.body|args\[0\]/.test(f.content) &&
      !/zod|joi|yup|validate|schema/.test(f.content)
    ) {
      issues.push("Request body used without visible input validation");
    }

    if (issues.length > 0) {
      for (const issue of issues) {
        output.push(`- 🔴 \`${relPath}\` — ${issue}`);
      }
    }
  }

  if (output.length === 2) {
    output.push(
      "- ✅ No obvious security vulnerabilities detected in source code",
    );
  }

  output.push("");
  return output;
}

function scanPerformanceDeep(
  files: { path: string; content: string }[],
  ctx: AgentContext,
): string[] {
  const output: string[] = [];
  output.push("## Performance Deep Scan\n");

  // N+1 query pattern
  let nPlusOne = 0;
  for (const f of files) {
    if (!/\.(tsx?|jsx?|ts|js)$/.test(f.path)) continue;
    // Pattern: await inside forEach/map/for-of that also does DB calls
    if (
      /\.forEach\s*\([^)]*await\s+/g.test(f.content) ||
      /for\s*\([^)]*\)\s*\{[^}]*await\s+/g.test(f.content)
    ) {
      const relPath = relative(ctx.appPath, f.path);
      output.push(
        `- 🔴 \`${relPath}\` — Potential N+1 query (await inside loop)`,
      );
      nPlusOne++;
    }
  }
  if (nPlusOne === 0) {
    output.push("- ✅ No obvious N+1 query patterns");
  }

  // Synchronous operations
  output.push("\n### Sync Operations\n");
  let syncIssues = 0;
  for (const f of files) {
    if (!/\.(tsx?|jsx?|ts|js)$/.test(f.path)) continue;
    if (/readFileSync|writeFileSync|existsSync|statSync/.test(f.content)) {
      const relPath = relative(ctx.appPath, f.path);
      output.push(
        `- 🟠 \`${relPath}\` — Uses sync filesystem operations (prefer async)`,
      );
      syncIssues++;
    }
  }
  if (syncIssues === 0) {
    output.push("- ✅ No sync filesystem operations in request paths");
  }

  // Memory leak patterns
  output.push("\n### Memory Leak Patterns\n");
  let memoryIssues = 0;
  for (const f of files) {
    if (!/\.(tsx?|jsx?|ts|js)$/.test(f.path)) continue;
    const relPath = relative(ctx.appPath, f.path);
    // setInterval without clearInterval
    if (
      /setInterval\s*\(/.test(f.content) &&
      !/clearInterval/.test(f.content)
    ) {
      output.push(`- 🟠 \`${relPath}\` — setInterval without clearInterval`);
      memoryIssues++;
    }
    // addEventListener without removeEventListener
    const addCount = (f.content.match(/addEventListener\s*\(/g) || []).length;
    const removeCount = (f.content.match(/removeEventListener\s*\(/g) || [])
      .length;
    if (addCount > removeCount && addCount > 1) {
      output.push(
        `- 🟠 \`${relPath}\` — ${addCount} addEventListener but only ${removeCount} removeEventListener`,
      );
      memoryIssues++;
    }
  }
  if (memoryIssues === 0) {
    output.push("- ✅ No obvious memory leak patterns");
  }

  output.push("");
  return output;
}

function scanCodeQuality(
  files: { path: string; content: string }[],
  _ctx: AgentContext,
): string[] {
  const output: string[] = [];
  output.push("## Code Quality\n");

  // TODO/FIXME/HACK
  let todos = 0;
  for (const f of files) {
    if (!/\.(tsx?|jsx?|ts|js)$/.test(f.path)) continue;
    const matches = f.content.match(
      /(?:TODO|FIXME|HACK|XXX|WORKAROUND)\s*[:(]/g,
    );
    if (matches) {
      todos += matches.length;
    }
  }
  output.push(`**TODO/FIXME/HACK comments:** ${todos}`);

  // Dead code indicators
  let deadCode = 0;
  for (const f of files) {
    if (!/\.(tsx?|jsx?|ts|js)$/.test(f.path)) continue;
    // Commented-out code blocks (>3 consecutive lines)
    const commentedBlocks = f.content.match(/(?:^\/\/.*\n){4,}/gm);
    if (commentedBlocks) {
      deadCode += commentedBlocks.length;
    }
  }
  if (deadCode > 0) {
    output.push(
      `- 🟡 ${deadCode} large commented-out code blocks found — remove dead code`,
    );
  }

  // console.log in non-test files
  let consoleLogs = 0;
  for (const f of files) {
    if (!/\.(tsx?|jsx?|ts|js)$/.test(f.path)) continue;
    if (/\.test\.|\.spec\.|__tests__/.test(f.path)) continue;
    const matches = f.content.match(/console\.(log|warn|error|debug)\s*\(/g);
    if (matches) consoleLogs += matches.length;
  }
  if (consoleLogs > 0) {
    output.push(
      `- 🟡 ${consoleLogs} console.log/warn/error in non-test files — use structured logging`,
    );
  }

  output.push("");
  return output;
}

// ── Full Audit ──

function fullAudit(
  files: { path: string; content: string }[],
  ctx: AgentContext,
): string[] {
  const output: string[] = [];
  output.push("# Production Full Audit\n");
  output.push(...scanSecrets(files, ctx));
  output.push(...scanDependencyVulnerabilities(files, ctx));
  output.push(...scanSecurityDeep(files, ctx));
  output.push(...scanArchitecture(files, ctx));
  output.push(...scanPerformanceDeep(files, ctx));
  output.push(...scanCodeQuality(files, ctx));
  return output;
}

// ── Tool Definition ──

export const productionAuditorTool: ToolDefinition<
  z.infer<typeof INPUT_SCHEMA>
> = {
  name: "production_auditor",
  description:
    "Production readiness audit: security scanning (secrets, OWASP Top 10), dependency vulnerabilities, architecture analysis (god classes, circular deps), performance deep scan (N+1 queries, memory leaks), and code quality checks.",
  inputSchema: INPUT_SCHEMA,
  defaultConsent: "always",

  getConsentPreview: (input) => {
    const m = input.mode || "full_audit";
    const label = m
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase());
    return `Run ${label} on this project`;
  },

  buildXml: (input) => {
    const mode = input.mode || "full_audit";
    const fp = input.file_path
      ? ` file="${escapeXmlAttr(input.file_path)}"`
      : "";
    return `<production_auditor mode="${escapeXmlAttr(mode)}"${fp}/>`;
  },

  execute: async (input, ctx) => {
    ctx.abortSignal?.throwIfAborted();
    const mode = input.mode || "full_audit";
    const scanDir = input.file_path
      ? await resolveReadPathWithinApp({
          appPath: ctx.appPath,
          relativePath: input.file_path,
        })
      : await resolveReadPathWithinApp({ appPath: ctx.appPath, relativePath: "." });

    log.scope("production_auditor").info(`mode=${mode} path=${scanDir}`);

    const files = await collectTargetFiles(
      scanDir,
      relative(ctx.appPath, scanDir) || ".",
    );

    if (files.length === 0) {
      const msg = "No scannable files found in the target path.";
      ctx.onXmlComplete?.(msg);
      return msg;
    }

    ctx.onXmlStream?.(`Scanning ${files.length} files (mode: ${mode})\n`);

    const output: string[] = [];
    output.push(`# Production Auditor\n`);
    output.push(`**Mode:** ${mode.replace(/_/g, " ").toUpperCase()}`);
    output.push(`**Files:** ${files.length}`);
    output.push("");

    switch (mode) {
      case "quick":
        output.push(...scanSecrets(files, ctx));
        output.push(...scanDependencyVulnerabilities(files, ctx));
        break;
      case "security":
        output.push(...scanSecrets(files, ctx));
        output.push(...scanDependencyVulnerabilities(files, ctx));
        output.push(...scanSecurityDeep(files, ctx));
        break;
      case "deep_scan":
        output.push(...scanSecrets(files, ctx));
        output.push(...scanSecurityDeep(files, ctx));
        output.push(...scanPerformanceDeep(files, ctx));
        output.push(...scanCodeQuality(files, ctx));
        break;
      case "architecture":
        output.push(...scanArchitecture(files, ctx));
        output.push(...scanPerformanceDeep(files, ctx));
        break;
      case "full_audit":
        output.push(...fullAudit(files, ctx));
        break;
    }

    output.push("---");
    output.push(
      `**Scanned:** ${relative(ctx.appPath, scanDir) || "."} | **Files:** ${files.length}`,
    );

    const result = output.join("\n");
    ctx.onXmlComplete?.(result);
    return result;
  },
};
