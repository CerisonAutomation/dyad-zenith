#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const failures = [];
const notes = [];
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const assert = (ok, message) => { if (!ok) failures.push(message); };
const exists = (p) => fs.existsSync(path.join(root, p));

const settings = read("src/main/settings.ts");
const defaults = read("src/agent/defaults.ts");
const schemas = read("src/lib/schemas.ts");
const models = read("src/ipc/utils/get_model_client.ts");
const catalog = read("src/ipc/shared/local_mcp_catalog.ts");
const tools = read("src/pro/main/ipc/handlers/local_agent/tool_definitions.ts");
const modelRuntime = read("src/pro/main/ipc/handlers/local_agent/agent_model_runtime.ts");
const agentPrompt = read("src/prompts/local_agent_prompt.ts");
const agentHandler = read("src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts");
const kiloGateway = read("src/ipc/shared/kilocode_gateway.ts");
const modelHelpers = read("src/ipc/shared/language_model_helpers.ts");
const buildApp = read("src/pro/main/ipc/handlers/local_agent/tools/build_app.ts");
const productionAuditor = read("src/pro/main/ipc/handlers/local_agent/tools/production_auditor.ts");
const uiUxReviewer = read("src/pro/main/ipc/handlers/local_agent/tools/ui_ux_reviewer.ts");
const runShellCommand = read("src/ipc/utils/runShellCommand.ts");
const streamChat = read("src/hooks/useStreamChat.ts");

assert(defaults.includes('provider: "auto"') && defaults.includes('name: "auto"'), "default model is not auto/auto");
assert(defaults.includes('DEFAULT_AGENT_MODE = "local-agent"'), "default runtime is not local-agent");
assert(settings.includes("DEFAULT_AGENT_MODEL") && settings.includes("DEFAULT_AGENT_MODE"), "settings bypass canonical agent defaults");
assert(settings.includes("defaultChatMode: DEFAULT_AGENT_MODE"), "default chat mode does not resolve to the canonical Dyad agent");
assert(!/function hasDyadProKey[\s\S]{0,200}return true/.test(schemas), "Dyad Pro trust boundary is fail-open");
assert(schemas.includes("settings.providerSettings?.auto?.apiKey?.value"), "Dyad credential is not scoped to the auto/Dyad provider");
assert(models.includes('"dyad/auto/kilocode"') && models.includes('"dyad/auto/openrouter"'), "Zenith Auto is not free-first");
assert(models.indexOf('"dyad/auto/kilocode"') < models.indexOf('"dyad/auto/openrouter"'), "Kilo free route is not the primary Auto candidate");
assert(kiloGateway.includes('KILOCODE_GATEWAY_BASE_URL = "https://api.kilo.ai/api/gateway"'), "Kilo gateway base URL drifted from the documented endpoint");
assert(!kiloGateway.includes("/api/gateway/v1"), "obsolete Kilo /v1 gateway path reintroduced");
assert(models.includes('resolved.providerId === "kilocode"') && models.includes("canUseKilocodeAnonymously"), "Zenith Auto no longer permits anonymous Kilo Auto Free");
assert(modelHelpers.includes('providerId === "kilocode"') && modelHelpers.includes("supportsAnonymousDiscovery"), "anonymous Kilo model discovery is disabled");
assert(buildApp.includes('const buildAppSchema = z.object({}).strict()'), "build_app accepts model-supplied command input");
assert(buildApp.includes('defaultConsent: "ask"'), "build_app executes repository code without consent");
assert(!buildApp.includes('args?.command') && !buildApp.includes('command: z.string'), "build_app arbitrary command override reintroduced");
assert(productionAuditor.includes("resolveReadPathWithinApp"), "production auditor path is not realpath-contained");
assert(uiUxReviewer.includes("resolveReadPathWithinApp"), "UI/UX reviewer path is not realpath-contained");
assert(runShellCommand.includes("shell: false"), "diagnostic command helper still invokes a shell");
assert(
  streamChat.includes('useSearch({ from: "/chat", shouldThrow: false })'),
  'shared useStreamChat hook can throw when /chat is not active',
);
assert(
  streamChat.includes('searchResult?.id'),
  'shared useStreamChat hook does not handle an absent /chat match',
);

for (const retired of ["sequential-thinking", "chain-of-thought", "deep-thinker", "structured-thinking", "prompt-ops", "everything", "brave-search"]) {
  assert(!catalog.includes(`slug: "${retired}"`), `redundant MCP still enabled: ${retired}`);
}
assert(!/ctx7sk-[A-Za-z0-9-]+/.test(catalog), "hard-coded Context7 credential detected");
const catalogSlugs = [...catalog.matchAll(/slug:\s*"([^"]+)"/g)].map((m) => m[1]);
const expectedCatalogSlugs = ["fetch", "memory", "playwright", "github", "context7"];
assert(JSON.stringify(catalogSlugs) === JSON.stringify(expectedCatalogSlugs), `MCP catalog drift: ${catalogSlugs.join(", ")}`);

const retiredTools = [
  "deepThinkTool", "multiAgentOrchestratorTool", "thoughtTreeTool", "promptOptimizerTool",
  "selfCritiqueTool", "autonomousExecutorTool", "qaCycleTool", "skillManagerTool",
  "zenithOrchestrateTool", "zenithBatchTool", "vibeWorkflowTool", "mvpAdvisorTool"
];
for (const name of retiredTools) assert(!tools.includes(`${name},`), `meta-tool remains model-visible: ${name}`);
for (const required of ["readFileTool", "writeFileTool", "gitTool", "runTypeChecksTool", "runTestsTool", "buildAppTool", "codeReviewerTool", "architectureAnalyzerTool", "productionAuditorTool"]) {
  assert(tools.includes(`${required},`), `required engineering tool missing: ${required}`);
}
assert(!tools.includes("onToolExecuted("), "hidden proactive second-brain hook still runs after tools");
assert(!modelRuntime.includes('model.provider === "auto"'), "model-backed intelligence tools still reject Zenith Auto");
for (const retired of ["deep_think", "thought_tree", "self_critique", "multi_agent_orchestrator", "autonomous_executor", "qa_cycle", "prompt_optimizer", "zenith_orchestrate"]) {
  assert(!agentPrompt.includes(retired), `retired meta-tool remains in canonical agent prompt: ${retired}`);
}
assert(agentPrompt.includes("single reasoning agent"), "canonical prompt does not declare the single-agent architecture");
assert(agentHandler.includes("isDyadPro: isDyadProEnabled(settings)"), "Dyad Pro context flag is conflated with generic model availability");
assert(!exists("src/hybrid_builder"), "parallel hybrid_builder architecture still exists");
for (const retiredPath of ["package-lock.json", "userData", ".dyad-encryption-key", ".claude", ".cursor", "e2e-opencode-test.js"]) {
  assert(!exists(retiredPath), `retired or unsafe distribution artifact still exists: ${retiredPath}`);
}
assert(exists("tools/repo-intel/mcp.mjs"), "deterministic repo-intel MCP is missing");
const repoMcp = read("tools/repo-intel/mcp.mjs");
assert(!repoMcp.includes("brain_analyze") && !repoMcp.includes("portable_tool_execute"), "repo-intel still exposes a second brain/tool runtime");

// Scan source/config for common live-secret prefixes. Test fixtures are allowed,
// but distribution/runtime state is not.
const scanRoots = ["src", "scripts", "tools/repo-intel", ".kilo"];
const secretPatterns = [
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bctx7sk-[A-Za-z0-9-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
function walk(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out=[];
  for (const e of fs.readdirSync(abs,{withFileTypes:true})) {
    const rel=path.join(dir,e.name);
    if (["node_modules","dist","out","coverage"].includes(e.name)) continue;
    if (e.isDirectory()) out.push(...walk(rel)); else out.push(rel);
  }
  return out;
}
for (const file of scanRoots.flatMap(walk)) {
  if (/(?:^|\/)(?:__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(file)) continue;
  if (!/\.(?:ts|tsx|js|mjs|cjs|json|jsonc|md|yaml|yml|env|example)$/.test(file)) continue;
  const text=read(file);
  for (const pattern of secretPatterns) {
    pattern.lastIndex=0;
    if (pattern.test(text)) failures.push(`possible live secret in ${file}: ${pattern.source}`);
  }
}

const packageJson = JSON.parse(read("package.json"));
assert(packageJson.scripts?.["repo:intel:mcp"], "repo-intel MCP script is missing");
assert(packageJson.scripts?.["verify:zenith"], "Zenith verification script is missing");
assert(packageJson.scripts?.["check:zenith"], "Zenith quick-check script is missing");
assert(packageJson.scripts?.["release:zenith"], "Zenith full release gate script is missing");
assert(packageJson.scripts?.["release:360"], "Zenith 360 E2E release gate script is missing");
assert(packageJson.scripts?.["check:360"], "Zenith 360 static gate script is missing");
assert(packageJson.scripts?.presubmit?.includes("lint:check") && !packageJson.scripts?.presubmit?.includes("lint --fix"), "presubmit must be non-mutating");
const ci = read(".github/workflows/ci.yml");
assert(!ci.includes("bun-version: latest"), "main CI uses floating Bun latest instead of the pinned project version");
assert(ci.includes("bun-version-file: .bun-version"), "main CI does not consume the pinned .bun-version");

const digest = crypto.createHash("sha256").update([
  settings, defaults, schemas, models, catalog, tools, modelRuntime, agentPrompt, agentHandler, repoMcp, kiloGateway, modelHelpers, buildApp, productionAuditor, uiUxReviewer, runShellCommand, streamChat
].join("\n---\n")).digest("hex");
notes.push(`policy_digest=${digest}`);
notes.push(`model_visible_tools=${(tools.match(/^\s{2}[A-Za-z][A-Za-z0-9]+Tool,/gm) || []).length}`);

if (failures.length) {
  console.error("ZENITH VERIFY: BLOCKED");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("ZENITH VERIFY: PASS");
for (const note of notes) console.log(` - ${note}`);
