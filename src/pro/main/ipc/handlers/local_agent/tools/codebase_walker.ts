/**
 * codebase_walker.ts — Shared async file-walking utility for analysis tools.
 * Shared bounded file walker for repository-level analysis tools such as production_auditor.
 *
 * All I/O is async (fs.promises) to avoid blocking the Electron main process.
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, extname, relative } from "path";

/** Default directories to skip during walks. */
const DEFAULT_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
]);

/** Default file extensions to include. */
const DEFAULT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".css",
  ".scss",
  ".html",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".py",
  ".go",
  ".rs",
  ".vue",
  ".svelte",
]);

export interface WalkOptions {
  /** Maximum recursion depth (default: 6). */
  maxDepth?: number;
  /** File extensions to include (default: DEFAULT_EXTENSIONS). */
  extensions?: Set<string>;
  /** Directory names to skip (default: DEFAULT_EXCLUDE). */
  exclude?: Set<string>;
  /** Maximum number of files to collect (default: 500). */
  limit?: number;
}

export interface WalkedFile {
  /** Path relative to the root directory. */
  path: string;
  /** File content. */
  content: string;
  /** Number of lines in the file. */
  lineCount: number;
}

/**
 * Walk a directory tree and collect file contents asynchronously.
 * Respects abort signals for cancellation.
 *
 * @param rootPath - Absolute path to the root directory
 * @param options - Walk configuration
 * @param abortSignal - Optional abort signal for cancellation
 * @returns Array of walked files with content
 */
export async function walkCodebase(
  rootPath: string,
  options: WalkOptions = {},
  abortSignal?: AbortSignal,
): Promise<WalkedFile[]> {
  const {
    maxDepth = 6,
    extensions = DEFAULT_EXTENSIONS,
    exclude = DEFAULT_EXCLUDE,
    limit = 500,
  } = options;

  const files: WalkedFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= limit) return;
    abortSignal?.throwIfAborted();

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Permission error or similar
    }

    for (const entry of entries) {
      if (files.length >= limit) break;
      abortSignal?.throwIfAborted();

      if (entry.name.startsWith(".") || exclude.has(entry.name)) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!extensions.has(ext)) continue;

        try {
          const content = await readFile(fullPath, "utf-8");
          files.push({
            path: relative(rootPath, fullPath),
            content,
            lineCount: content.split("\n").length,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(rootPath, 0);
  return files;
}

/**
 * Get summary statistics for a set of walked files.
 */
export function summarizeFiles(files: WalkedFile[]): {
  totalFiles: number;
  totalLines: number;
  languages: string[];
  extensions: Map<string, number>;
} {
  const extensions = new Map<string, number>();
  let totalLines = 0;

  for (const f of files) {
    totalLines += f.lineCount;
    const ext = extname(f.path).toLowerCase() || "(no ext)";
    extensions.set(ext, (extensions.get(ext) || 0) + 1);
  }

  const extToLang: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript (React)",
    ".js": "JavaScript",
    ".jsx": "JavaScript (React)",
    ".css": "CSS",
    ".scss": "SCSS",
    ".html": "HTML",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".md": "Markdown",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".vue": "Vue",
    ".svelte": "Svelte",
    ".mjs": "JavaScript (ESM)",
  };

  const languages = [
    ...new Set(
      [...extensions.keys()].map((ext) => extToLang[ext] || ext.slice(1)),
    ),
  ];

  return {
    totalFiles: files.length,
    totalLines,
    languages,
    extensions,
  };
}

/**
 * Collect files from a single path (file or directory).
 * Convenience wrapper around walkCodebase for single-target tools.
 */
export async function collectTargetFiles(
  targetPath: string,
  relPath: string,
  options: WalkOptions = {},
  abortSignal?: AbortSignal,
): Promise<WalkedFile[]> {
  const { stat: statFn } = await import("fs/promises");

  try {
    const s = await statFn(targetPath);
    if (s.isFile()) {
      const content = await readFile(targetPath, "utf-8");
      return [
        {
          path: relPath,
          content,
          lineCount: content.split("\n").length,
        },
      ];
    }
  } catch {
    return [];
  }

  return walkCodebase(targetPath, options, abortSignal);
}
