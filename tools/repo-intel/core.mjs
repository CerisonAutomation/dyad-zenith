import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const IGNORE = new Set([
    ".git", "node_modules", "out", "dist", ".vite", "coverage", "userData",
    "test-results", "playwright-report", ".remember", ".playwright-mcp",
]);
const TEXT_EXT = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".md",
    ".yml", ".yaml", ".css", ".scss", ".html", ".sql", ".sh", ".toml", ".env",
]);
const MAX_FILE_BYTES = 1_000_000;
export function resolveRepo(input = ".") {
    const root = fs.realpathSync(process.env.REPO_INTEL_ROOT || process.cwd());
    const target = fs.realpathSync(path.resolve(root, input));
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel))
        throw new Error("Path escapes repository root");
    return target;
}
export function walkFiles(root) {
    const out = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (IGNORE.has(entry.name))
                continue;
            const abs = path.join(dir, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory())
                visit(abs);
            else if (entry.isFile())
                out.push(abs);
        }
    };
    visit(root);
    return out;
}
function safeText(file) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES)
        return null;
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file);
    if (!TEXT_EXT.has(ext) && !["Dockerfile", "Makefile", ".gitignore", ".npmrc"].includes(name))
        return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0))
        return null;
    return buf.toString("utf8");
}
export function summarizeRepo(root) {
    const files = walkFiles(root);
    const languages = {};
    let bytes = 0;
    let lines = 0;
    const largest = [];
    for (const file of files) {
        const stat = fs.statSync(file);
        bytes += stat.size;
        const ext = path.extname(file).toLowerCase() || "[none]";
        languages[ext] = (languages[ext] || 0) + 1;
        const text = safeText(file);
        if (text)
            lines += text.split(/\r?\n/).length;
        largest.push({ file: path.relative(root, file), bytes: stat.size });
    }
    largest.sort((a, b) => b.bytes - a.bytes);
    let pkg = null;
    const pkgPath = path.join(root, "package.json");
    if (fs.existsSync(pkgPath))
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return {
        root,
        files: files.length,
        bytes,
        lines,
        languages: Object.fromEntries(Object.entries(languages).sort((a, b) => b[1] - a[1])),
        largest: largest.slice(0, 20),
        package: pkg ? {
            name: pkg.name,
            version: pkg.version,
            scripts: Object.keys(pkg.scripts || {}),
            dependencies: Object.keys(pkg.dependencies || {}).length,
            devDependencies: Object.keys(pkg.devDependencies || {}).length,
        } : null,
    };
}
export function searchRepo(root, query, max = 100) {
    if (!query || query.length > 500)
        throw new Error("query must be 1-500 characters");
    const rx = new RegExp(query, "i");
    const matches = [];
    for (const file of walkFiles(root)) {
        const text = safeText(file);
        if (!text)
            continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (rx.test(lines[i])) {
                matches.push({ file: path.relative(root, file), line: i + 1, text: lines[i].slice(0, 500) });
                if (matches.length >= max)
                    return matches;
            }
        }
    }
    return matches;
}
export function scanRisks(root) {
    const findings = [];
    const rules = [
        { severity: "critical", rule: "private-key", rx: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, message: "Private key material is embedded in source" },
        { severity: "critical", rule: "groq-key", rx: /\bgsk_[A-Za-z0-9]{20,}\b/, message: "Groq credential-like value is embedded in source" },
        { severity: "critical", rule: "github-token", rx: /\bghp_[A-Za-z0-9]{20,}\b/, message: "GitHub token-like value is embedded in source" },
        { severity: "critical", rule: "context7-key", rx: /\bctx7sk-[A-Za-z0-9-]{20,}\b/, message: "Context7 credential-like value is embedded in source" },
        { severity: "high", rule: "electron-node-integration", rx: /nodeIntegration\s*:\s*true/, message: "Electron nodeIntegration is enabled" },
        { severity: "high", rule: "electron-context-isolation", rx: /contextIsolation\s*:\s*false/, message: "Electron contextIsolation is disabled" },
        { severity: "high", rule: "shell-exec", rx: /\bexecSync?\s*\(/, message: "Shell-style child process execution requires injection review" },
    ];
    for (const file of walkFiles(root)) {
        const rel = path.relative(root, file);
        if (/(?:^|\/)(?:__tests__|fixtures?|e2e-tests|testing)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(rel))
            continue;
        const text = safeText(file);
        if (!text)
            continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            for (const rule of rules) {
                rule.rx.lastIndex = 0;
                if (rule.rx.test(lines[i])) {
                    const severity = rel.startsWith("src/") ? rule.severity : (rule.severity === "critical" ? "critical" : "medium");
                    findings.push({ severity, rule: rule.rule, file: rel, line: i + 1, message: rule.message });
                }
            }
        }
    }
    return findings;
}
export function importGraph(root) {
    const files = walkFiles(root).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
    const edges = [];
    const importRx = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
    for (const file of files) {
        const text = safeText(file);
        if (!text)
            continue;
        importRx.lastIndex = 0;
        for (let m; (m = importRx.exec(text));) {
            if (!m[1].startsWith("."))
                continue;
            edges.push({ from: path.relative(root, file), to: m[1] });
        }
    }
    const incoming = new Map();
    for (const e of edges)
        incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    return { files: files.length, edges: edges.length, topImportedSpecifiers: [...incoming.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30) };
}
export function gitEvidence(root) {
    const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 10_000 });
    const rev = run(["rev-parse", "HEAD"]);
    const status = run(["status", "--porcelain=v1"]);
    return {
        revision: rev.status === 0 ? rev.stdout.trim() : null,
        dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
        status: status.status === 0 ? status.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 200) : [],
    };
}
export function verifyRepo(root, execute = false) {
    const packagePath = path.join(root, "package.json");
    if (!fs.existsSync(packagePath))
        return { status: "BLOCKED", reason: "package.json missing", gates: [] };
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const required = ["verify:zenith", "ts", "test", "build"];
    const missing = required.filter((g) => !pkg.scripts?.[g]);
    if (missing.length)
        return { status: "BLOCKED", reason: `missing mandatory scripts: ${missing.join(", ")}`, gates: [] };
    if (!execute)
        return { status: "DESIGNED", reason: "execution disabled; set REPO_INTEL_ALLOW_EXEC=1 or pass --exec", gates: required.map((name) => ({ name, status: "not-run" })) };
    const gates = [];
    for (const name of required) {
        const started = Date.now();
        const r = spawnSync("bun", ["run", name], { cwd: root, encoding: "utf8", shell: false, timeout: name === "build" ? 15 * 60_000 : 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
        gates.push({ name, status: r.status === 0 ? "pass" : "fail", exitCode: r.status, durationMs: Date.now() - started, stdout: (r.stdout || "").slice(-12000), stderr: (r.stderr || "").slice(-12000), error: r.error?.message });
        if (r.status !== 0)
            return { status: "BLOCKED", gates };
    }
    return { status: "VERIFIED", gates };
}
export function sourceDigest(root) {
    const hash = crypto.createHash("sha256");
    for (const file of walkFiles(root).sort()) {
        const rel = path.relative(root, file);
        hash.update(rel);
        hash.update("\0");
        hash.update(fs.readFileSync(file));
        hash.update("\0");
    }
    return hash.digest("hex");
}
