import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import fixPath from "fix-path";
import killPort from "kill-port";
import log from "electron-log";
import { eq } from "drizzle-orm";

import { getAppPort, getAppProxyPort } from "../../../shared/ports";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { readSettings } from "@/main/settings";
import {
  shouldShowPnpmMinimumReleaseAgeWarning,
  type RuntimeMode2,
} from "@/lib/schemas";
import {
  getFrameworkDevPortStrategy,
  type AppFrameworkType,
} from "@/lib/framework_constants";
import { detectFrameworkType } from "@/ipc/utils/framework_utils";
import type { AppRuntimeOutput } from "@/ipc/types/app_runtime";
import type { AppRunInvocationRef } from "@/app_run/state";
import {
  CancellationTombstones,
  createInvocationRef,
  invocationRegistryKey,
  sameInvocationRef,
} from "@/state_machines/invocation_ref";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { addLog, clearLogs } from "@/lib/log_store";
import { getDyadAppPath } from "@/paths/paths";
import { startProxy } from "@/ipc/utils/start_proxy_server";
import {
  buildCloudSandboxFileMap,
  CloudSandboxApiError,
  createCloudSandbox,
  destroyCloudSandbox,
  registerRunningCloudSandbox,
  setCloudSandboxSyncUpdateListener,
  streamCloudSandboxLogs,
  uploadCloudSandboxFiles,
  restartCloudSandbox,
} from "@/ipc/utils/cloud_sandbox_provider";
import {
  processCounter,
  removeAppIfCurrentProcess,
  removeDockerVolumesForApp,
  runningApps,
  stopAppByInfo,
  type RunningAppInfo,
} from "@/ipc/utils/process_manager";
import {
  appOperationCoordinator,
  readAppResource,
  type AppOperationRequest,
} from "@/ipc/services/app_operation_coordinator";
import { APP_RUN_INVOCATION_KIND } from "@/app_run/state";
import {
  ensurePnpmAllowBuildsConfigured,
  getPackageManagerCommandEnv,
  getPnpmMinimumReleaseAgeSupport,
  isPnpmIgnoredBuildsError,
  parsePnpmIgnoredBuildsFromOutput,
  type PackageManager,
  PNPM_PM_ON_FAIL_IGNORE_ARG,
  PNPM_INSTALL_POLICY_ARGS,
  getBestEffortPnpmRebuildCommand,
} from "@/ipc/utils/socket_firewall";
import { parseCompilationError } from "@/ipc/utils/dev_server_error_parser";
import {
  recordAndReportDeniedPnpmBuilds,
  resolvePnpmIgnoredBuilds,
} from "@/ipc/utils/pnpm_denied_builds";
import {
  getManagedPnpmMajorVersion,
  isPnpmVersionMigrationNeeded,
} from "@/ipc/utils/pnpm_migration";
import {
  detectExistingDevServer,
  findFreePort,
} from "@/ipc/utils/dev_server_detector";
import {
  choosePackageManagerFromSignal,
  getPackageManagerSignal,
  signalPrefersPnpm,
} from "@/ipc/utils/package_manager_selection";

const logger = log.scope("app_runtime_service");
const pnpmVersionMigrationNotifiedAppIds = new Set<number>();

/**
 * Transport-neutral output boundary captured by a runtime producer.
 *
 * IPC is one adapter today; the future main-hosted actor can consume these
 * callbacks directly without manufacturing an Electron event.
 */
export type { AppRuntimeOutput } from "@/ipc/types/app_runtime";

// Needed, otherwise Electron on macOS/Linux may not find node/pnpm.
fixPath();

export function formatCloudSandboxError(error: unknown) {
  if (!(error instanceof CloudSandboxApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  switch (error.code) {
    case "sandbox_pro_required":
      return "Dyad Pro is required to use cloud sandboxes.";
    case "sandbox_insufficient_credits":
      return "You need at least 1 credit available to start a cloud sandbox.";
    case "sandbox_billing_unavailable":
      return "Dyad couldn’t verify sandbox billing right now. Please try again.";
    case "sandbox_credits_exhausted":
      return "This cloud sandbox stopped because your credits ran out.";
    default:
      if (error.status === 404) {
        return "This cloud sandbox is no longer available.";
      }
      if (error.status === 401 || error.status === 403) {
        return "Dyad couldn’t authorize the cloud sandbox request. Please try again.";
      }
      if (error.status === 429) {
        return "Dyad is rate limiting cloud sandbox requests right now. Please try again.";
      }
      if (typeof error.status === "number" && error.status >= 500) {
        return "Dyad’s cloud sandbox service is temporarily unavailable. Please try again.";
      }
      return error.message;
  }
}

function getPnpmInstallCommand(): string {
  return `pnpm ${PNPM_INSTALL_POLICY_ARGS.join(" ")} install`;
}

function getPnpmRunCommand(): string {
  return `pnpm ${PNPM_PM_ON_FAIL_IGNORE_ARG} run dev`;
}

function getPnpmStaticServeCommand(port: number): string {
  return `npx --yes serve -l ${port} .`;
}

function getNpmStaticServeCommand(port: number): string {
  return `npx --yes serve -l ${port} .`;
}

/** Read the package.json dev script ("" when absent). */
function readDevScript(appPath: string): string {
  try {
    const raw = fs.readFileSync(path.join(appPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts?.dev ?? "";
  } catch {
    return "";
  }
}

function buildPnpmInstallAndRunCommand(input: {
  promotedPackages: string[];
  port: number;
  devScript: string;
  frameworkType: AppFrameworkType | null;
}): string {
  const strategy = getFrameworkDevPortStrategy(
    input.devScript,
    input.frameworkType,
  );
  const devCommand =
    strategy === "script"
      ? getPnpmStaticServeCommand(input.port)
      : strategy === "env"
        ? `PORT=${input.port} ${getPnpmRunCommand()}`
        : `${getPnpmRunCommand()} --port ${input.port}`;
  return [
    getPnpmInstallCommand(),
    getBestEffortPnpmRebuildCommand(input.promotedPackages),
    devCommand,
  ]
    .filter(Boolean)
    .join(" && ");
}

function getNpmInstallCommand(): string {
  return "npm install --legacy-peer-deps";
}

interface AppRuntimeCommand {
  command: string;
  isCustom: boolean;
  packageManager: PackageManager | null;
}

async function getDefaultCommand({
  runtimeMode,
  appId,
  appPath,
  onPnpmMinimumReleaseAgeWarning,
}: {
  runtimeMode: RuntimeMode2;
  appId: number;
  appPath: string;
  onPnpmMinimumReleaseAgeWarning?: (message: string) => void;
}): Promise<AppRuntimeCommand> {
  const port = getAppPort(appId);
  const devScript = readDevScript(appPath);
  const frameworkType = detectFrameworkType(appPath);
  const portStrategy = getFrameworkDevPortStrategy(devScript, frameworkType);
  if (runtimeMode === "docker") {
    const allowBuildsResult = await ensurePnpmAllowBuildsConfigured({
      appPath,
    });
    return {
      command: buildPnpmInstallAndRunCommand({
        promotedPackages: allowBuildsResult.promotedPackages,
        port,
        devScript,
        frameworkType,
      }),
      isCustom: false,
      packageManager: "pnpm",
    };
  }

  const pnpmSupport = await getPnpmMinimumReleaseAgeSupport();
  const signal = getPackageManagerSignal(appPath);
  const packageManager = choosePackageManagerFromSignal({
    signal,
    pnpmAvailable: pnpmSupport.available,
  });

  // Only warn about pnpm when the app actually wants pnpm — including while
  // it temporarily falls back to npm because pnpm is missing/too old. Apps
  // that explicitly select npm should not see pnpm warnings.
  if (
    signalPrefersPnpm(signal) &&
    !pnpmSupport.minimumReleaseAgeSupported &&
    pnpmSupport.warningMessage
  ) {
    onPnpmMinimumReleaseAgeWarning?.(pnpmSupport.warningMessage);
  }

  if (packageManager === "npm") {
    const devCommand =
      portStrategy === "script"
        ? getNpmStaticServeCommand(port)
        : portStrategy === "env"
          ? `PORT=${port} npm run dev`
          : `npm run dev -- --port ${port}`;
    return {
      command: `(${getNpmInstallCommand()} && ${devCommand})`,
      isCustom: false,
      packageManager: "npm",
    };
  }

  const allowBuildsResult = await ensurePnpmAllowBuildsConfigured({ appPath });
  return {
    command: buildPnpmInstallAndRunCommand({
      promotedPackages: allowBuildsResult.promotedPackages,
      port,
      devScript,
      frameworkType,
    }),
    isCustom: false,
    packageManager: "pnpm",
  };
}

async function getCommand({
  runtimeMode,
  appId,
  appPath,
  installCommand,
  startCommand,
  onPnpmMinimumReleaseAgeWarning,
}: {
  runtimeMode: RuntimeMode2;
  appId: number;
  appPath: string;
  installCommand?: string | null;
  startCommand?: string | null;
  onPnpmMinimumReleaseAgeWarning?: (message: string) => void;
}): Promise<AppRuntimeCommand> {
  const hasCustomCommands = !!installCommand?.trim() && !!startCommand?.trim();
  if (hasCustomCommands) {
    const port = getAppPort(appId);
    // Inject PORT so Express/Fastify/custom servers can pick up Dyad's allocated
    // port. Servers that ignore PORT still work — the proxy detects the URL from
    // their stdout and auto-connects (see ensureProxyForRunningApp).
    const portedStart = `PORT=${port} ${startCommand!.trim()}`;
    return {
      command: `${installCommand!.trim()} && ${portedStart}`,
      isCustom: true,
      packageManager: null,
    };
  }

  return getDefaultCommand({
    runtimeMode,
    appId,
    appPath,
    onPnpmMinimumReleaseAgeWarning,
  });
}

function emitPnpmMinimumReleaseAgeWarning({
  appId,
  output,
  message,
}: {
  appId: number;
  output: AppRuntimeOutput;
  message: string;
}) {
  const settings = readSettings();
  if (!shouldShowPnpmMinimumReleaseAgeWarning(settings)) {
    return;
  }

  output.send({
    type: "package-manager-warning",
    warningKind: "release-age",
    message,
    appId,
  });
}

export async function executeApp({
  appPath,
  appId,
  output,
  isNeon,
  installCommand,
  startCommand,
  invocationRef,
}: {
  appPath: string;
  appId: number;
  output: AppRuntimeOutput;
  isNeon: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
  invocationRef?: AppRunInvocationRef;
}): Promise<void> {
  const settings = readSettings();
  const runtimeMode = settings.runtimeMode2 ?? "host";

  if (runtimeMode === "docker") {
    await executeAppInDocker({
      appPath,
      appId,
      output,
      isNeon,
      installCommand,
      startCommand,
      invocationRef,
    });
  } else if (runtimeMode === "cloud") {
    await executeAppInCloud({
      appPath,
      appId,
      output,
      installCommand,
      startCommand,
      invocationRef,
    });
  } else {
    notifyPnpmVersionMigrationAvailable({ appPath, appId, output });
    await executeAppLocalNode({
      appPath,
      appId,
      output,
      isNeon,
      installCommand,
      startCommand,
      invocationRef,
    });
  }
}

// Discovery nudge for the consented "Migrate to pnpm N" app upgrade: the
// contradiction (old pin/lockfile vs the managed pnpm) only bites outside
// Dyad (CI, deploys, teammates), so surface it in the console the user is
// already watching instead of failing or silently rewriting the pin.
function notifyPnpmVersionMigrationAvailable({
  appPath,
  appId,
  output,
}: {
  appPath: string;
  appId: number;
  output: AppRuntimeOutput;
}): void {
  try {
    if (!isPnpmVersionMigrationNeeded(appPath)) {
      return;
    }
    const managedMajor = getManagedPnpmMajorVersion();
    if (!pnpmVersionMigrationNotifiedAppIds.has(appId)) {
      output.send({
        type: "stdout",
        message: `This pnpm app needs a pnpm ${managedMajor} migration (pre-9 lockfile or pnpm <= 8 pin). Dyad already runs pnpm ${managedMajor}, so deploys, CI, and teammates' installs can drift without the matching project pin. Open App Details -> App Upgrades and apply "Migrate to pnpm ${managedMajor}".`,
        appId,
      });
      pnpmVersionMigrationNotifiedAppIds.add(appId);
    }
    output.send({
      type: "package-manager-warning",
      warningKind: "pnpm-migration",
      message: `This app pins an older pnpm that can't read the lockfile Dyad writes. Migrate to pnpm ${managedMajor} so CI, deploys, and teammates can install it reliably.`,
      appId,
    });
  } catch (error) {
    logger.warn("Failed to check pnpm version migration status:", error);
  }
}

export function emitProxyServerStarted({
  appId,
  output,
  proxyUrl,
  originalUrl,
  mode,
  invocationRef,
}: {
  appId: number;
  output: AppRuntimeOutput;
  proxyUrl: string;
  originalUrl: string;
  mode: RuntimeMode2;
  invocationRef?: AppRunInvocationRef;
}) {
  output.send({
    type: "stdout",
    message: `[dyad-proxy-server]started=[${proxyUrl}] original=[${originalUrl}] mode=[${mode}]`,
    appId,
    invocationRef,
  });
}

export async function ensureProxyForRunningApp({
  appId,
  output,
  originalUrl,
  mode,
  invocationRef,
}: {
  appId: number;
  output: AppRuntimeOutput;
  originalUrl: string;
  mode: RuntimeMode2;
  invocationRef?: AppRunInvocationRef;
}): Promise<void> {
  const appInfo = runningApps.get(appId);
  if (!appInfo) {
    return;
  }
  if (
    invocationRef &&
    (!appInfo.invocationRef ||
      !sameInvocationRef(appInfo.invocationRef, invocationRef))
  ) {
    // Producer callbacks are bound to their spawned process's ref. Reject an
    // old callback before it can terminate or replace the current proxy.
    return;
  }

  const proxyAuthToken =
    mode === "cloud" ? appInfo.cloudPreviewAuthToken : undefined;

  if (
    appInfo.proxyWorker &&
    appInfo.originalUrl === originalUrl &&
    appInfo.proxyAuthToken === proxyAuthToken &&
    appInfo.proxyUrl
  ) {
    emitProxyServerStarted({
      appId,
      output,
      proxyUrl: appInfo.proxyUrl,
      originalUrl,
      mode,
      invocationRef,
    });
    return;
  }

  if (appInfo.proxyWorker) {
    await appInfo.proxyWorker.terminate();
    appInfo.proxyWorker = undefined;
  }

  // Prefer the deterministic port so the iframe origin stays stable across
  // restarts — otherwise origin-scoped browser state (auth sessions,
  // localStorage) gets orphaned and users appear logged out. If that port is
  // already taken (by a foreign service, or another Dyad app in the rare 10k
  // overlap), the proxy worker scans the fallback band upward rather than
  // killing whatever holds the port.
  const proxyPort = getAppProxyPort(appId);

  const proxyWorker = await startProxy(originalUrl, {
    port: proxyPort,
    onStarted: (proxyUrl) => {
      const latestAppInfo = runningApps.get(appId);
      if (
        latestAppInfo &&
        (!invocationRef ||
          (latestAppInfo.invocationRef &&
            sameInvocationRef(latestAppInfo.invocationRef, invocationRef)))
      ) {
        latestAppInfo.proxyUrl = proxyUrl;
        latestAppInfo.originalUrl = originalUrl;
        latestAppInfo.proxyAuthToken = proxyAuthToken;
      }
      emitProxyServerStarted({
        appId,
        output,
        proxyUrl,
        originalUrl,
        mode,
        invocationRef,
      });
    },
    onError: (error) => {
      logger.error(`Failed to start proxy for app ${appId}:`, error);
      output.send({
        type: "stderr",
        message: `[dyad-proxy-server] ${error.message}`,
        appId,
      });
    },
    fixedHeaders:
      mode === "cloud" && proxyAuthToken
        ? {
            Authorization: `Bearer ${proxyAuthToken}`,
          }
        : undefined,
  });

  const latestAppInfo = runningApps.get(appId);
  if (
    latestAppInfo &&
    (!invocationRef ||
      (latestAppInfo.invocationRef &&
        sameInvocationRef(latestAppInfo.invocationRef, invocationRef)))
  ) {
    latestAppInfo.proxyWorker = proxyWorker;
    latestAppInfo.originalUrl = originalUrl;
    latestAppInfo.proxyAuthToken = proxyAuthToken;
  } else {
    await proxyWorker.terminate();
  }
}

function loadProjectEnvFiles(appPath: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const fileName of [".env.local", ".env"]) {
    try {
      const content = fs.readFileSync(path.join(appPath, fileName), "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq <= 0) {
          continue;
        }
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        if (key) {
          result[key] = value;
        }
      }
    } catch {
      // file missing or unreadable — fine, project may not use env files
    }
  }
  return result;
}

/**
 * Remove a directory tree (node_modules) with retry.
 * On macOS, recursive rm against a large pnpm store (.pnpm with hundreds of
 * symlinked dirs) races with still-running child processes and throws
 * ENOTEMPTY/EBUSY — historically the #1 `rebuild_app` failure. Retry with
 * backoff, and escalate to `mv`-aside (rename to a trash name, then delete)
 * so a fresh install never blocks on a half-removed tree.
 */
async function removeNodeModulesWithRetry(
  target: string,
  attempts = 6,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.promises.rm(target, {
        recursive: true,
        force: true,
        maxRetries: 12,
        retryDelay: 150,
      });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 400 * (attempt + 1)),
      );
    }
  }

  // Last resort: rename the tree aside (atomic, never fails on busy dirs),
  // then delete the renamed copy in the background.
  try {
    const trashName = `${target}.dyad-remove-${Date.now()}`;
    await fs.promises.rename(target, trashName);
    void fs.promises
      .rm(trashName, { recursive: true, force: true })
      .catch(() => undefined);
    return;
  } catch {
    // rename failed too — surface the original error
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to remove " + target);
}

async function executeAppLocalNode({
  appPath,
  appId,
  output,
  isNeon,
  installCommand,
  startCommand,
  invocationRef,
  ignoredBuildsSelfHealAttempted = false,
}: {
  appPath: string;
  appId: number;
  output: AppRuntimeOutput;
  isNeon: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
  invocationRef?: AppRunInvocationRef;
  ignoredBuildsSelfHealAttempted?: boolean;
}): Promise<void> {
  const command = await getCommand({
    runtimeMode: "host",
    appId,
    appPath,
    installCommand,
    startCommand,
    onPnpmMinimumReleaseAgeWarning: (message) =>
      emitPnpmMinimumReleaseAgeWarning({ appId, output, message }),
  });
  let env = { ...process.env };
  // Standard project env convention: load .env.local / .env from the app dir
  // so custom dev entries (e.g. `tsx server.ts`) get the same env that
  // `next dev` would load. Real environment variables take precedence.
  const projectEnv = loadProjectEnvFiles(appPath);
  for (const [key, value] of Object.entries(projectEnv)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  if (!command.isCustom && command.packageManager === "pnpm") {
    env = getPackageManagerCommandEnv(env);
  }

  const spawnedProcess = spawn(command.command, [], {
    cwd: appPath,
    env,
    shell: true,
    stdio: "pipe",
    detached: false,
  });

  if (!spawnedProcess.pid) {
    let errorOutput = "";
    let spawnErr: any | null = null;
    spawnedProcess.stderr?.on(
      "data",
      (data) => (errorOutput += data.toString()),
    );
    await new Promise<void>((resolve) => {
      spawnedProcess.once("error", (err) => {
        spawnErr = err;
        resolve();
      });
    });

    const details = [
      spawnErr?.message ? `message=${spawnErr.message}` : null,
      spawnErr?.code ? `code=${spawnErr.code}` : null,
      spawnErr?.errno ? `errno=${spawnErr.errno}` : null,
      spawnErr?.syscall ? `syscall=${spawnErr.syscall}` : null,
      spawnErr?.path ? `path=${spawnErr.path}` : null,
      spawnErr?.spawnargs
        ? `spawnargs=${JSON.stringify(spawnErr.spawnargs)}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    logger.error(
      `Failed to spawn process for app ${appId}. Command="${command.command}", CWD="${appPath}", ${details}\nSTDERR:\n${
        errorOutput || "(empty)"
      }`,
    );

    throw new Error(
      `Failed to spawn process for app ${appId}.
Error output:
${errorOutput || "(empty)"}
Details: ${details || "n/a"}
`,
    );
  }

  const currentProcessId = processCounter.increment();
  runningApps.set(appId, {
    process: spawnedProcess,
    processId: currentProcessId,
    invocationRef,
    mode: "host",
    output,
    lastViewedAt: Date.now(),
  });

  listenToProcess({
    process: spawnedProcess,
    appId,
    appPath,
    isNeon,
    output,
    invocationRef,
    onPnpmIgnoredBuildsFailure:
      command.isCustom && !ignoredBuildsSelfHealAttempted
        ? async (processOutput) => {
            const healed = await selfHealDeniedPnpmBuilds({
              appPath,
              output: processOutput,
              telemetrySource: "self-heal",
            });
            if (!healed) {
              return false;
            }

            // Per "Transparent Over Magical": tell the user why the
            // process restarted instead of silently reinstalling.
            output.send({
              type: "stdout",
              message:
                "pnpm blocked dependency build scripts. Dyad recorded the decision in pnpm-workspace.yaml and is reinstalling...",
              appId,
            });

            await executeAppLocalNode({
              appPath,
              appId,
              output,
              isNeon,
              installCommand,
              startCommand,
              invocationRef,
              ignoredBuildsSelfHealAttempted: true,
            });
            return true;
          }
        : undefined,
    onCompilationError: (error) => {
      // Surface the error to the user via output
      output.send({
        type: "compilation-error",
        message: `Compilation error: ${error.summary}`,
        appId,
        compilationError: error,
      });
      addLog({
        level: "error",
        type: "server",
        message: `Compilation error detected: ${error.summary}`,
        timestamp: Date.now(),
        appId,
      });
    },
  });
}

let cloudSandboxSyncUpdateListenerRegistered = false;

export function registerCloudSandboxSyncUpdateListener(): void {
  if (cloudSandboxSyncUpdateListenerRegistered) {
    return;
  }

  setCloudSandboxSyncUpdateListener(({ appId, errorMessage }) => {
    const appInfo = runningApps.get(appId);
    if (!appInfo || appInfo.mode !== "cloud") {
      return;
    }

    const previousErrorMessage = appInfo.cloudSyncErrorMessage ?? null;
    appInfo.cloudSyncErrorMessage = errorMessage ?? undefined;

    const output = appInfo.output;
    if (!output) {
      return;
    }

    if (errorMessage) {
      if (previousErrorMessage === errorMessage) {
        return;
      }

      addLog({
        level: "error",
        type: "server",
        message: errorMessage,
        timestamp: Date.now(),
        appId,
      });

      output.send({
        type: "sync-error",
        message: errorMessage,
        appId,
      });
      return;
    }

    if (!previousErrorMessage) {
      return;
    }

    const recoveredMessage =
      "Cloud sandbox sync recovered. Local changes are uploading again.";

    addLog({
      level: "info",
      type: "server",
      message: recoveredMessage,
      timestamp: Date.now(),
      appId,
    });

    output.send({
      type: "sync-recovered",
      message: recoveredMessage,
      appId,
    });
  });

  cloudSandboxSyncUpdateListenerRegistered = true;
}

// Records builds that a successful install skipped (the "Ignored build
// scripts" warning path) so the decision lands in pnpm-workspace.yaml and a
// later plain `pnpm install` (export/CI/Rebuild) cannot fail on
// ERR_PNPM_IGNORED_BUILDS. Best-effort: reads [] when .modules.yaml is
// absent (npm apps, Docker-volume installs).
async function recordIgnoredBuildsAfterInstall(appPath: string): Promise<void> {
  try {
    const ignoredBuilds = await resolvePnpmIgnoredBuilds(appPath);
    await recordAndReportDeniedPnpmBuilds({
      appPath,
      ignoredBuilds,
      source: "app-run",
    });
  } catch (error) {
    logger.warn("Failed to record ignored pnpm builds after install:", error);
  }
}

function listenToProcess({
  process: spawnedProcess,
  appId,
  appPath,
  isNeon,
  output,
  invocationRef,
  onPnpmIgnoredBuildsFailure,
  onCompilationError,
}: {
  process: ChildProcess;
  appId: number;
  appPath?: string;
  isNeon: boolean;
  output: AppRuntimeOutput;
  invocationRef?: AppRunInvocationRef;
  onPnpmIgnoredBuildsFailure?: (output: string) => Promise<boolean>;
  onCompilationError?: (error: {
    summary: string;
    rawOutput: string;
    framework: string;
    fixable: boolean;
  }) => void;
}) {
  // Rolling tail, kept only while a self-heal callback could still use it:
  // dev servers run for hours and unbounded accumulation would leak memory.
  // The ERR_PNPM_IGNORED_BUILDS marker appears at the end of a failed
  // install, so a bounded tail is sufficient for the close-handler check.
  const MAX_PROCESS_OUTPUT_TAIL_LENGTH = 64 * 1024;
  let processOutput = "";
  let ignoredBuildsRecordedAfterInstall = false;
  const appendProcessOutput = (message: string) => {
    if (!onPnpmIgnoredBuildsFailure) {
      return;
    }
    processOutput = (processOutput + message).slice(
      -MAX_PROCESS_OUTPUT_TAIL_LENGTH,
    );
  };

  // Compilation error detection buffer — accumulates recent output to
  // detect framework-specific compilation errors from the dev server.
  const MAX_COMPILATION_ERROR_BUFFER = 16000;
  let compilationErrorBuffer = "";
  let compilationErrorDetected = false;
  let urlEmitted = false;

  const checkForCompilationError = (message: string) => {
    if (compilationErrorDetected || !onCompilationError) return;
    compilationErrorBuffer = (compilationErrorBuffer + message).slice(
      -MAX_COMPILATION_ERROR_BUFFER,
    );
    const parsed = parseCompilationError(compilationErrorBuffer, "");
    if (parsed) {
      compilationErrorDetected = true;
      // Store in RunningAppInfo for waitForAppReady to access
      const appInfo = runningApps.get(appId);
      if (appInfo) {
        appInfo.compilationError = parsed;
      }
      try {
        onCompilationError(parsed);
      } catch (err) {
        logger.warn(
          `onCompilationError callback failed for app ${appId}:`,
          err,
        );
      }
    }
  };
  spawnedProcess.stdout?.on("data", async (data) => {
    const message = util.stripVTControlCharacters(data.toString());
    appendProcessOutput(message);
    logger.debug(
      `App ${appId} (PID: ${spawnedProcess.pid}) stdout: ${message}`,
    );

    addLog({
      level: "info",
      type: "server",
      message,
      timestamp: Date.now(),
      appId,
    });

    if (isNeon && message.includes("created or renamed from another")) {
      spawnedProcess.stdin?.write(`\r\n`);
      logger.info(
        `App ${appId} (PID: ${spawnedProcess.pid}) wrote enter to stdin to automatically respond to drizzle push input`,
      );
    }

    const inputRequestPattern = /\s*›\s*\([yY]\/[nN]\)\s*$/;
    const isInputRequest = inputRequestPattern.test(message);
    if (isInputRequest) {
      output.send({
        type: "input-requested",
        message,
        appId,
      });
    } else {
      output.enqueue({
        type: "stdout",
        message,
        appId,
      });

      // Match ANY URL (not just localhost — Python/Go/Deno use 127.0.0.1, 0.0.0.0, etc.)
      const urlMatch = message.match(
        /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+\/?)/,
      );
      // Generic port detection on ready/listening lines.
      // Patterns: "ready port: 32103", "listening on :32103", "server on 0.0.0.0:32103",
      // "Running on http://127.0.0.1:32103", "Serving on port 32103",
      // "bound to port 32103", ":32103" near ready|listen|start|serve|run|bound
      const portMatch = !urlMatch
        ? message.match(/port[^\d]{0,10}(\d{4,5})|:(\d{4,5})(?:\/|\s|$)/i)
        : null;
      const readyLine =
        /ready|listen(ing)?\s|started|serv(ing|e)\s|local:|on\s+port|bound\s+to|running\s+on/i.test(
          message,
        );
      const originalUrl = urlMatch
        ? urlMatch[1]
        : portMatch && readyLine
          ? `http://localhost:${portMatch[1] || portMatch[2]}`
          : undefined;
      if (originalUrl) {
        urlEmitted = true;
        // The dev-server URL appearing means the install phase completed
        // successfully — the one point in the `install && dev` chain where
        // ignored builds can be read and recorded.
        if (appPath && !ignoredBuildsRecordedAfterInstall) {
          ignoredBuildsRecordedAfterInstall = true;
          await recordIgnoredBuildsAfterInstall(appPath);
        }
        await ensureProxyForRunningApp({
          appId,
          output,
          originalUrl,
          mode: "host",
          invocationRef,
        });
      }
    }

    // Check for compilation errors in stdout (Next.js often prints errors here)
    checkForCompilationError(message);
  });

  spawnedProcess.stderr?.on("data", async (data) => {
    const message = util.stripVTControlCharacters(data.toString());
    appendProcessOutput(message);
    logger.error(
      `App ${appId} (PID: ${spawnedProcess.pid}) stderr: ${message}`,
    );

    addLog({
      level: "error",
      type: "server",
      message,
      timestamp: Date.now(),
      appId,
    });

    output.enqueue({
      type: "stderr",
      message,
      appId,
    });

    // Check for compilation errors in stderr (most frameworks print errors here)
    checkForCompilationError(message);
  });

  spawnedProcess.on("close", (code, signal) => {
    void (async () => {
      try {
        logger.log(
          `App ${appId} (PID: ${spawnedProcess.pid}) process closed with code ${code}, signal ${signal}.`,
        );
        output.flush();
        const currentAppInfo = runningApps.get(appId);
        if (!currentAppInfo || currentAppInfo.process !== spawnedProcess) {
          removeAppIfCurrentProcess(appId, spawnedProcess);
          return;
        }

        if (
          code !== 0 &&
          onPnpmIgnoredBuildsFailure &&
          isPnpmIgnoredBuildsError(processOutput)
        ) {
          let retried = false;
          try {
            retried = await onPnpmIgnoredBuildsFailure(processOutput);
          } catch (error) {
            logger.warn(
              `Failed to self-heal pnpm ignored builds for app ${appId}:`,
              error,
            );
          }
          if (retried) {
            return;
          }
        }

        output.send({
          type: "app-exit",
          message: `App process exited with code ${code ?? "null"}`,
          appId,
          invocationRef,
          exitCode: code,
          signal,
          timestamp: Date.now(),
        });
        removeAppIfCurrentProcess(appId, spawnedProcess);
      } catch (error) {
        // The close handler is a critical lifecycle point; never let an
        // unexpected error leave a stale runningApps entry behind.
        logger.error(
          `Unexpected error in close handler for app ${appId}:`,
          error,
        );
        removeAppIfCurrentProcess(appId, spawnedProcess);
      }
    })();
  });

  spawnedProcess.on("error", (err) => {
    logger.error(
      `Error in app ${appId} (PID: ${spawnedProcess.pid}) process: ${err.message}`,
    );
    removeAppIfCurrentProcess(appId, spawnedProcess);
  });
}

async function selfHealDeniedPnpmBuilds({
  appPath,
  output,
  telemetrySource,
  removeNodeModules = true,
}: {
  appPath: string;
  output: string;
  telemetrySource: "self-heal";
  // Docker installs use the container volume, not host node_modules, and an
  // explicit `pkg: false` entry passes even a fast-path install — so the
  // Docker caller skips the host cleanup.
  removeNodeModules?: boolean;
}): Promise<boolean> {
  const ignoredBuilds = await resolvePnpmIgnoredBuilds(appPath, output);
  // recordDeniedPnpmBuilds may also promote previously auto-denied packages
  // as a side effect; no explicit `pnpm rebuild` is needed here because
  // node_modules is removed below, so the retry's fresh install runs build
  // scripts for newly-allowed packages natively.
  const { deniedBuilds } = await recordAndReportDeniedPnpmBuilds({
    appPath,
    ignoredBuilds,
    source: telemetrySource,
  });
  if (deniedBuilds.length === 0) {
    return false;
  }

  if (removeNodeModules) {
    await removeNodeModulesWithRetry(path.join(appPath, "node_modules"));
  }

  return true;
}

async function executeAppInDocker({
  appPath,
  appId,
  output,
  isNeon,
  installCommand,
  startCommand,
  invocationRef,
  ignoredBuildsSelfHealAttempted = false,
}: {
  appPath: string;
  appId: number;
  output: AppRuntimeOutput;
  isNeon: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
  invocationRef?: AppRunInvocationRef;
  ignoredBuildsSelfHealAttempted?: boolean;
}): Promise<void> {
  const containerName = `dyad-app-${appId}`;

  try {
    await new Promise<void>((resolve, reject) => {
      const checkDocker = spawn("docker", ["--version"], { stdio: "pipe" });
      checkDocker.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error("Docker is not available"));
        }
      });
      checkDocker.on("error", () => {
        reject(new Error("Docker is not available"));
      });
    });
  } catch {
    throw new Error(
      "Docker is required but not available. Please install Docker Desktop and ensure it's running.",
    );
  }

  try {
    await new Promise<void>((resolve) => {
      const stopContainer = spawn("docker", ["stop", containerName], {
        stdio: "pipe",
      });
      stopContainer.on("close", () => {
        const removeContainer = spawn("docker", ["rm", containerName], {
          stdio: "pipe",
        });
        removeContainer.on("close", () => resolve());
        removeContainer.on("error", () => resolve());
      });
      stopContainer.on("error", () => resolve());
    });
  } catch (error) {
    logger.info(
      `Docker container ${containerName} not found. Ignoring error: ${error}`,
    );
  }

  const dockerfilePath = path.join(appPath, "Dockerfile.dyad");
  if (!fs.existsSync(dockerfilePath)) {
    const dockerfileContent = `FROM node:22-alpine

# Install pnpm
RUN npm install -g pnpm
`;

    try {
      await fs.promises.writeFile(dockerfilePath, dockerfileContent, "utf-8");
    } catch (error) {
      logger.error(`Failed to create Dockerfile for app ${appId}:`, error);
      throw new DyadError(
        `Failed to create Dockerfile: ${error}`,
        DyadErrorKind.External,
      );
    }
  }

  const buildProcess = spawn(
    "docker",
    ["build", "-f", "Dockerfile.dyad", "-t", `dyad-app-${appId}`, "."],
    {
      cwd: appPath,
      stdio: "pipe",
    },
  );

  let buildError = "";
  buildProcess.stderr?.on("data", (data) => {
    buildError += data.toString();
  });

  await new Promise<void>((resolve, reject) => {
    buildProcess.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker build failed: ${buildError}`));
      }
    });
    buildProcess.on("error", (err) => {
      reject(new Error(`Docker build process error: ${err.message}`));
    });
  });

  const port = getAppPort(appId);
  const process = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "-p",
      `${port}:${port}`,
      "-v",
      `${appPath}:/app`,
      "-v",
      `dyad-pnpm-${appId}:/app/.pnpm-store`,
      "-e",
      "PNPM_STORE_PATH=/app/.pnpm-store",
      "-w",
      "/app",
      `dyad-app-${appId}`,
      "sh",
      "-c",
      (
        await getCommand({
          runtimeMode: "docker",
          appId,
          appPath,
          installCommand,
          startCommand,
          onPnpmMinimumReleaseAgeWarning: (message) =>
            emitPnpmMinimumReleaseAgeWarning({ appId, output, message }),
        })
      ).command,
    ],
    {
      stdio: "pipe",
      detached: false,
    },
  );

  if (!process.pid) {
    let errorOutput = "";
    let spawnErr: any = null;
    process.stderr?.on("data", (data) => (errorOutput += data.toString()));
    await new Promise<void>((resolve) => {
      process.once("error", (err) => {
        spawnErr = err;
        resolve();
      });
    });

    const details = [
      spawnErr?.message ? `message=${spawnErr.message}` : null,
      spawnErr?.code ? `code=${spawnErr.code}` : null,
      spawnErr?.errno ? `errno=${spawnErr.errno}` : null,
      spawnErr?.syscall ? `syscall=${spawnErr.syscall}` : null,
      spawnErr?.path ? `path=${spawnErr.path}` : null,
      spawnErr?.spawnargs
        ? `spawnargs=${JSON.stringify(spawnErr.spawnargs)}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    logger.error(
      `Failed to spawn Docker container for app ${appId}. ${details}\nSTDERR:\n${
        errorOutput || "(empty)"
      }`,
    );

    throw new Error(
      `Failed to spawn Docker container for app ${appId}.
Details: ${details || "n/a"}
STDERR:
${errorOutput || "(empty)"}`,
    );
  }

  const currentProcessId = processCounter.increment();
  runningApps.set(appId, {
    process,
    processId: currentProcessId,
    invocationRef,
    mode: "docker",
    output,
    containerName,
    lastViewedAt: Date.now(),
  });

  // Mirrors the host path: custom `install && start` chains run strict pnpm
  // inside the container, so an ERR_PNPM_IGNORED_BUILDS exit needs the same
  // record-denials-and-retry treatment (executeAppInDocker is restart-safe —
  // it stops and removes the previous container first).
  const hasCustomCommands = !!installCommand?.trim() && !!startCommand?.trim();
  listenToProcess({
    process,
    appId,
    appPath,
    isNeon,
    output,
    invocationRef,
    onPnpmIgnoredBuildsFailure:
      hasCustomCommands && !ignoredBuildsSelfHealAttempted
        ? async (processOutput) => {
            const healed = await selfHealDeniedPnpmBuilds({
              appPath,
              output: processOutput,
              telemetrySource: "self-heal",
              removeNodeModules: false,
            });
            if (!healed) {
              return false;
            }

            output.send({
              type: "stdout",
              message:
                "pnpm blocked dependency build scripts. Dyad recorded the decision in pnpm-workspace.yaml and is reinstalling...",
              appId,
            });

            await executeAppInDocker({
              appPath,
              appId,
              output,
              isNeon,
              installCommand,
              startCommand,
              invocationRef,
              ignoredBuildsSelfHealAttempted: true,
            });
            return true;
          }
        : undefined,
  });
}

async function executeAppInCloud({
  appPath,
  appId,
  output,
  installCommand,
  startCommand,
  invocationRef,
}: {
  appPath: string;
  appId: number;
  output: AppRuntimeOutput;
  installCommand?: string | null;
  startCommand?: string | null;
  invocationRef?: AppRunInvocationRef;
}): Promise<void> {
  const currentProcessId = processCounter.increment();
  let sandboxId: string | undefined;
  let previewUrl: string | undefined;
  let previewAuthToken: string | undefined;

  try {
    const createResult = await createCloudSandbox({
      appId,
      appPath,
      installCommand,
      startCommand,
    });
    sandboxId = createResult.sandboxId;
    previewUrl = createResult.previewUrl;
    previewAuthToken = createResult.previewAuthToken;

    const files = await buildCloudSandboxFileMap(appPath);
    const uploadResult = await uploadCloudSandboxFiles({
      sandboxId,
      files,
      replaceAll: true,
    });
    previewUrl = uploadResult.previewUrl ?? previewUrl;
    previewAuthToken = uploadResult.previewAuthToken ?? previewAuthToken;
  } catch (error) {
    if (sandboxId) {
      try {
        await destroyCloudSandbox(sandboxId);
      } catch (cleanupError) {
        logger.warn(
          `Failed to clean up cloud sandbox ${sandboxId} after startup error for app ${appId}:`,
          cleanupError,
        );
      }
    }
    throw new Error(formatCloudSandboxError(error));
  }

  const resolvedPreviewUrl = previewUrl;
  const resolvedPreviewAuthToken = previewAuthToken;
  if (!sandboxId || !resolvedPreviewUrl || !resolvedPreviewAuthToken) {
    throw new Error(
      "Cloud sandbox startup returned incomplete preview credentials.",
    );
  }

  const cloudLogAbortController = new AbortController();
  runningApps.set(appId, {
    process: null,
    processId: currentProcessId,
    invocationRef,
    mode: "cloud",
    output,
    cloudSandboxId: sandboxId,
    cloudPreviewUrl: resolvedPreviewUrl,
    cloudPreviewAuthToken: resolvedPreviewAuthToken,
    cloudLogAbortController,
    lastViewedAt: Date.now(),
    originalUrl: resolvedPreviewUrl,
  });
  registerRunningCloudSandbox({
    appId,
    appPath,
    sandboxId,
  });

  await ensureProxyForRunningApp({
    appId,
    output,
    originalUrl: resolvedPreviewUrl,
    mode: "cloud",
    invocationRef,
  });

  startCloudSandboxLogStream({
    appId,
    appPath,
    output,
    sandboxId,
    cloudLogAbortController,
  });
}

export function startCloudSandboxLogStream(input: {
  appId: number;
  appPath?: string;
  output: AppRuntimeOutput;
  sandboxId: string;
  cloudLogAbortController: AbortController;
}) {
  // The sandbox install runs remotely and node_modules is never synced back,
  // so the only way to observe ignored builds is the "Ignored build scripts"
  // line in the streamed install output. Keep a bounded tail across chunks
  // (the line may be split) and record denials locally once, best-effort.
  const MAX_LOG_TAIL_LENGTH = 16 * 1024;
  let logTail = "";
  let ignoredBuildsRecorded = false;
  const maybeRecordIgnoredBuilds = (message: string) => {
    if (!input.appPath || ignoredBuildsRecorded) {
      return;
    }
    logTail = (logTail + message).slice(-MAX_LOG_TAIL_LENGTH);
    const ignoredBuilds = parsePnpmIgnoredBuildsFromOutput(logTail);
    if (ignoredBuilds.length === 0) {
      return;
    }
    ignoredBuildsRecorded = true;
    const appPath = input.appPath;
    void (async () => {
      try {
        // Output-only on purpose: the install ran remotely, so the local
        // .modules.yaml (if any) does not describe this sandbox.
        await appOperationCoordinator.run(
          {
            appId: input.appId,
            operation: "record-cloud-pnpm-build-policy",
            resources: [readAppResource("app-path"), "repository"],
          },
          () =>
            recordAndReportDeniedPnpmBuilds({
              appPath,
              ignoredBuilds,
              source: "cloud-sandbox",
            }),
        );
      } catch (error) {
        logger.warn(
          "Failed to record ignored pnpm builds from cloud sandbox logs:",
          error,
        );
      }
    })();
  };

  void (async () => {
    try {
      for await (const message of streamCloudSandboxLogs(
        input.sandboxId,
        input.cloudLogAbortController.signal,
      )) {
        const appInfo = runningApps.get(input.appId);
        if (!appInfo || appInfo.cloudSandboxId !== input.sandboxId) {
          return;
        }

        maybeRecordIgnoredBuilds(message);

        addLog({
          level: "info",
          type: "server",
          message,
          timestamp: Date.now(),
          appId: input.appId,
        });

        input.output.send({
          type: "stdout",
          message,
          appId: input.appId,
        });
      }
    } catch (error) {
      if (input.cloudLogAbortController.signal.aborted) {
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : `Cloud sandbox log stream failed: ${String(error)}`;

      addLog({
        level: "error",
        type: "server",
        message,
        timestamp: Date.now(),
        appId: input.appId,
      });

      input.output.send({
        type: "stderr",
        message,
        appId: input.appId,
      });
    }
  })();
}

async function killProcessOnPort(port: number): Promise<void> {
  try {
    await killPort(port, "tcp");
  } catch {
    // Ignore if nothing was running on that port.
  }
}

async function stopDockerContainersOnPort(port: number): Promise<void> {
  try {
    const list = spawn("docker", ["ps", "--filter", `publish=${port}`, "-q"], {
      stdio: "pipe",
    });

    let stdout = "";
    list.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    await new Promise<void>((resolve) => {
      list.on("close", () => resolve());
      list.on("error", () => resolve());
    });

    const containerIds = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (containerIds.length === 0) {
      return;
    }

    await Promise.all(
      containerIds.map(
        (id) =>
          new Promise<void>((resolve) => {
            const stop = spawn("docker", ["stop", id], { stdio: "pipe" });
            stop.on("close", () => resolve());
            stop.on("error", () => resolve());
          }),
      ),
    );
  } catch (e) {
    logger.warn(`Failed stopping Docker containers on port ${port}: ${e}`);
  }
}

export async function cleanUpPort(port: number) {
  const settings = readSettings();
  if (settings.runtimeMode2 === "docker") {
    await stopDockerContainersOnPort(port);
  } else {
    await killProcessOnPort(port);
  }
}

interface RuntimeAppRecord {
  id: number;
  path: string;
  neonProjectId: string | null;
  installCommand: string | null;
  startCommand: string | null;
}

export interface AppRuntimeServiceDependencies {
  runSerialized<T>(
    appId: number,
    lifecycle: AppRuntimeLifecycle,
    operation: () => Promise<T>,
  ): Promise<T>;
  findApp(appId: number): Promise<RuntimeAppRecord | undefined>;
  resolveAppPath(relativePath: string): string;
  getRunningApp(appId: number): RunningAppInfo | undefined;
  deleteRunningApp(appId: number): void;
  getProcessCounter(): number;
  startProcess(input: {
    appPath: string;
    appId: number;
    output: AppRuntimeOutput;
    isNeon: boolean;
    installCommand?: string | null;
    startCommand?: string | null;
    invocationRef?: AppRunInvocationRef;
  }): Promise<void>;
  stopProcess(appId: number, appInfo: RunningAppInfo): Promise<void>;
  removeCurrentProcess(appId: number, process: ChildProcess): void;
  cleanPort(port: number): Promise<void>;
  restartSandbox(sandboxId: string): Promise<{
    previewUrl: string;
    previewAuthToken: string;
  }>;
  ensureProxy(input: {
    appId: number;
    output: AppRuntimeOutput;
    originalUrl: string;
    mode: RuntimeMode2;
    invocationRef?: AppRunInvocationRef;
  }): Promise<void>;
  startCloudLogs(input: {
    appId: number;
    appPath?: string;
    output: AppRuntimeOutput;
    sandboxId: string;
    cloudLogAbortController: AbortController;
  }): void;
  clearLogs(appId: number): void;
  readRuntimeMode(): RuntimeMode2;
  removeNodeModules(appPath: string): Promise<void>;
  removeDockerVolumes(appId: number): Promise<void>;
  waitForReady(appId: number, timeoutMs?: number): Promise<void>;
  createId(): string;
  now(): number;
}

export type AppRuntimeLifecycle = "start" | "restart" | "stop";

export function getAppRuntimeOperationResources(
  lifecycle: AppRuntimeLifecycle,
): AppOperationRequest["resources"] {
  if (lifecycle === "stop") return ["runtime"];
  return [
    readAppResource("app-path"),
    readAppResource("repository"),
    "runtime",
    readAppResource("runtime-config"),
  ];
}

export interface StartAppRuntimeOptions {
  appId: number;
  output: AppRuntimeOutput;
  invocationRef?: AppRunInvocationRef;
  readyTimeoutMs?: number;
}

export interface RestartAppRuntimeOptions extends StartAppRuntimeOptions {
  removeNodeModules?: boolean;
  recreateSandbox?: boolean;
  clearRuntimeLogs?: boolean;
}

export interface ExternalAppRuntimeLifecycleOptions {
  appId: number;
  output: AppRuntimeOutput;
  operation: "restart" | "rebuild";
  abortSignal?: AbortSignal;
  invocationRef?: AppRunInvocationRef;
  timeoutMs?: number;
}

export interface ExternalAppRuntimeClaim {
  requestId: string;
  invocationRef: AppRunInvocationRef;
  appId: number;
  operation: "restart" | "rebuild";
  output: AppRuntimeOutput;
}

const DEFAULT_APP_READY_TIMEOUT_MS = 2 * 60 * 1_000;
const APP_READY_POLL_MS = 100;
const MAX_RUNTIME_CANCELLATION_TOMBSTONES = 1_000;

/**
 * Cohesive, transport-neutral owner of main-process app runtime commands.
 *
 * IPC handlers and Local Agent tools are adapters over this seam. Producer
 * output is captured in the command input and passed unchanged to process,
 * proxy, and sandbox callbacks, preserving invocation identity at producer
 * creation.
 */
export class AppRuntimeService {
  private readonly externalClaims = new Map<string, ExternalAppRuntimeClaim>();
  private readonly externalClaimsByApp = new Map<
    number,
    Map<string, ExternalAppRuntimeClaim>
  >();
  private readonly cancellationTombstones = new CancellationTombstones(
    MAX_RUNTIME_CANCELLATION_TOMBSTONES,
  );

  constructor(private readonly dependencies: AppRuntimeServiceDependencies) {}

  async start(options: StartAppRuntimeOptions): Promise<void> {
    const { appId, output, invocationRef } = options;
    return this.dependencies.runSerialized(appId, "start", async () => {
      const existing = this.dependencies.getRunningApp(appId);
      if (existing) {
        logger.debug(`App ${appId} is already running.`);
        if (existing.proxyUrl && existing.originalUrl) {
          emitProxyServerStarted({
            appId,
            output,
            proxyUrl: existing.proxyUrl,
            originalUrl: existing.originalUrl,
            mode: existing.mode,
            invocationRef: invocationRef ?? existing.invocationRef,
          });
        }
        return;
      }

      const app = await this.requireApp(appId);
      const appPath = this.dependencies.resolveAppPath(app.path);

      // Check for an already-running dev server before spawning one.
      // Cursor/Bolt/Replit all detect existing servers — avoids port conflicts
      // and duplicate processes.
      const frameworkType = detectFrameworkType(appPath);
      const existingServer = await detectExistingDevServer(frameworkType, appPath);
      if (existingServer) {
        logger.info(
          `App ${appId}: found existing ${existingServer.framework} dev server on port ${existingServer.port} — reusing`,
        );
        await ensureProxyForRunningApp({
          appId,
          output,
          originalUrl: existingServer.url,
          mode: "host",
          invocationRef,
        });
        return;
      }

      logger.debug(`Starting app ${appId} in path ${app.path}`);
      let processStarted = false;
      try {
        await this.dependencies.cleanPort(getAppPort(appId));
        await this.startProcess(app, appPath, options);
        processStarted = true;
        await this.dependencies.waitForReady(appId, options.readyTimeoutMs);
      } catch (error) {
        logger.error(`Error running app ${appId}:`, error);
        if (!processStarted) {
          const latest = this.dependencies.getRunningApp(appId);
          if (
            latest &&
            latest.processId === this.dependencies.getProcessCounter()
          ) {
            this.dependencies.deleteRunningApp(appId);
          }
        }
        throw new DyadError(
          `Failed to run app ${appId}: ${errorMessage(error)}`,
          DyadErrorKind.External,
        );
      }
    });
  }

  async restart(options: RestartAppRuntimeOptions): Promise<void> {
    const {
      appId,
      output,
      invocationRef,
      removeNodeModules = false,
      recreateSandbox = false,
      clearRuntimeLogs = false,
    } = options;
    logger.log(`Restarting app ${appId}`);
    return this.dependencies.runSerialized(appId, "restart", async () => {
      const app = await this.requireApp(appId);
      const appPath = this.dependencies.resolveAppPath(app.path);
      const appInfo = this.dependencies.getRunningApp(appId);

      if (
        appInfo?.mode === "cloud" &&
        appInfo.cloudSandboxId &&
        !recreateSandbox
      ) {
        await this.restartCloudSandboxInPlace({
          appId,
          appPath,
          output,
          invocationRef,
          clearRuntimeLogs,
          appInfo,
        });
        await this.dependencies.waitForReady(appId, options.readyTimeoutMs);
        return;
      }

      if (appInfo) {
        logger.log(
          `Stopping app ${appId} (processId ${appInfo.processId}) before restart`,
        );
        await this.dependencies.stopProcess(appId, appInfo);
      } else {
        logger.log(`App ${appId} not running. Proceeding to start.`);
      }

      await this.dependencies.cleanPort(getAppPort(appId));
      if (removeNodeModules) {
        const runtimeMode = this.dependencies.readRuntimeMode();
        await this.dependencies.removeNodeModules(appPath);
        if (runtimeMode === "docker") {
          try {
            await this.dependencies.removeDockerVolumes(appId);
          } catch (error) {
            logger.warn(
              `Failed to remove Docker volumes for app ${appId}. Continuing: ${error}`,
            );
          }
        }
      }
      if (clearRuntimeLogs) {
        this.dependencies.clearLogs(appId);
      }
      await this.startProcess(app, appPath, options);
      await this.dependencies.waitForReady(appId, options.readyTimeoutMs);
    });
  }

  async stop(appId: number): Promise<void> {
    logger.log(
      `Attempting to stop app ${appId}. Current running apps: ${runningApps.size}`,
    );
    return this.dependencies.runSerialized(appId, "stop", async () => {
      const appInfo = this.dependencies.getRunningApp(appId);
      if (!appInfo) {
        logger.log(`App ${appId} is already stopped.`);
        return;
      }

      const { process, processId } = appInfo;
      if (
        process &&
        (process.exitCode !== null || process.signalCode !== null)
      ) {
        this.dependencies.deleteRunningApp(appId);
        return;
      }

      try {
        await this.dependencies.stopProcess(appId, appInfo);
        if (process) {
          this.dependencies.removeCurrentProcess(appId, process);
        }
      } catch (error) {
        logger.error(
          `Error stopping app ${appId} (processId ${processId}):`,
          error,
        );
        if (process) {
          this.dependencies.removeCurrentProcess(appId, process);
        } else if (appInfo.mode !== "cloud") {
          this.dependencies.deleteRunningApp(appId);
        }
        throw new DyadError(
          `Failed to stop app ${appId}: ${errorMessage(error)}`,
          DyadErrorKind.External,
        );
      }
    });
  }

  clearRuntimeLogs(appId: number): void {
    this.dependencies.clearLogs(appId);
  }

  waitForReady(
    appId: number,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    return this.dependencies.waitForReady(appId, options.timeoutMs);
  }

  isRunning(appId: number): boolean {
    return this.dependencies.getRunningApp(appId) !== undefined;
  }

  createExternalLifecycleRef(appId: number): AppRunInvocationRef {
    return createInvocationRef(APP_RUN_INVOCATION_KIND, appId, {
      next: (prefix) => `${prefix}:${this.dependencies.createId()}`,
    });
  }

  claimExternalLifecycle(
    options: ExternalAppRuntimeLifecycleOptions,
  ): ExternalAppRuntimeClaim | undefined {
    const invocationRef =
      options.invocationRef ?? this.createExternalLifecycleRef(options.appId);
    if (this.cancellationTombstones.has(invocationRef)) {
      return undefined;
    }
    const claim: ExternalAppRuntimeClaim = {
      requestId: this.dependencies.createId(),
      invocationRef,
      appId: options.appId,
      operation: options.operation,
      output: options.output,
    };
    this.externalClaims.set(invocationRegistryKey(invocationRef), claim);
    let claims = this.externalClaimsByApp.get(options.appId);
    if (!claims) {
      claims = new Map();
      this.externalClaimsByApp.set(options.appId, claims);
    }
    claims.set(invocationRef.operationId, claim);
    options.output.send({
      type: "agent-lifecycle-started",
      message: `${options.operation === "rebuild" ? "Rebuilding" : "Restarting"} app`,
      appId: options.appId,
      invocationRef,
      timestamp: this.dependencies.now(),
      lifecycleRequestId: claim.requestId,
      lifecycleOperation: options.operation,
    });
    return claim;
  }

  cancelExternalLifecycle(invocationRef: AppRunInvocationRef): void {
    this.cancellationTombstones.add(invocationRef);
    const claim = this.externalClaims.get(invocationRegistryKey(invocationRef));
    if (claim) {
      this.releaseExternalClaim(claim);
    }
  }

  async executeExternalLifecycle(
    options: ExternalAppRuntimeLifecycleOptions,
  ): Promise<void> {
    const invocationRef =
      options.invocationRef ?? this.createExternalLifecycleRef(options.appId);
    if (options.abortSignal?.aborted) {
      this.cancelExternalLifecycle(invocationRef);
      throw new DyadError(
        "The app lifecycle operation was cancelled before it started",
        DyadErrorKind.UserCancelled,
      );
    }
    const claim = this.claimExternalLifecycle({
      ...options,
      invocationRef,
    });
    if (!claim) {
      throw new DyadError(
        "The app lifecycle operation was cancelled before it started",
        DyadErrorKind.UserCancelled,
      );
    }
    try {
      await this.restart({
        appId: options.appId,
        output: options.output,
        invocationRef,
        removeNodeModules: options.operation === "rebuild",
        recreateSandbox: options.operation === "rebuild",
        clearRuntimeLogs: true,
        readyTimeoutMs: options.timeoutMs,
      });
      this.settleExternalClaim(claim);
    } catch (error) {
      this.settleExternalClaim(
        claim,
        error,
        this.dependencies.getRunningApp(options.appId) !== undefined,
      );
      throw error;
    }
  }

  /**
   * Disposes service-owned claims for a deleted app. Late completions are
   * recognized by bounded tombstones and cannot settle a replacement claim.
   */
  cleanup(appId: number): void {
    for (const claim of this.externalClaimsByApp.get(appId)?.values() ?? []) {
      this.cancellationTombstones.add(claim.invocationRef);
      this.externalClaims.delete(invocationRegistryKey(claim.invocationRef));
    }
    this.externalClaimsByApp.delete(appId);
  }

  cleanupAll(): void {
    for (const appId of this.externalClaimsByApp.keys()) {
      this.cleanup(appId);
    }
  }

  private async requireApp(appId: number): Promise<RuntimeAppRecord> {
    const app = await this.dependencies.findApp(appId);
    if (!app) {
      throw new DyadError("App not found", DyadErrorKind.NotFound);
    }
    return app;
  }

  private startProcess(
    app: RuntimeAppRecord,
    appPath: string,
    options: StartAppRuntimeOptions,
  ): Promise<void> {
    return this.dependencies.startProcess({
      appPath,
      appId: options.appId,
      output: options.output,
      isNeon: !!app.neonProjectId,
      installCommand: app.installCommand,
      startCommand: app.startCommand,
      invocationRef: options.invocationRef,
    });
  }

  private async restartCloudSandboxInPlace(input: {
    appId: number;
    appPath: string;
    output: AppRuntimeOutput;
    invocationRef?: AppRunInvocationRef;
    clearRuntimeLogs: boolean;
    appInfo: RunningAppInfo;
  }): Promise<void> {
    const sandboxId = input.appInfo.cloudSandboxId!;
    input.appInfo.cloudLogAbortController?.abort();
    const result = await this.dependencies.restartSandbox(sandboxId);
    input.appInfo.cloudPreviewUrl = result.previewUrl;
    input.appInfo.cloudPreviewAuthToken = result.previewAuthToken;
    input.appInfo.lastViewedAt = this.dependencies.now();
    input.appInfo.invocationRef = input.invocationRef;
    input.appInfo.output = input.output;
    input.appInfo.cloudLogAbortController = new AbortController();
    if (input.clearRuntimeLogs) {
      this.dependencies.clearLogs(input.appId);
    }
    await this.dependencies.ensureProxy({
      appId: input.appId,
      output: input.output,
      originalUrl: result.previewUrl,
      mode: "cloud",
      invocationRef: input.invocationRef,
    });
    this.dependencies.startCloudLogs({
      appId: input.appId,
      appPath: input.appPath,
      output: input.output,
      sandboxId,
      cloudLogAbortController: input.appInfo.cloudLogAbortController,
    });
  }

  private settleExternalClaim(
    claim: ExternalAppRuntimeClaim,
    error?: unknown,
    runtimeMayBeLive = false,
  ): void {
    const active = this.externalClaims.get(
      invocationRegistryKey(claim.invocationRef),
    );
    if (
      active !== claim ||
      this.cancellationTombstones.has(claim.invocationRef)
    ) {
      return;
    }
    claim.output.send({
      type: error ? "agent-lifecycle-failed" : "agent-lifecycle-succeeded",
      message: error ? errorMessage(error) : `App ${claim.operation} succeeded`,
      appId: claim.appId,
      invocationRef: claim.invocationRef,
      lifecycleRequestId: claim.requestId,
      lifecycleOperation: claim.operation,
      ...(error ? { lifecycleRuntimeMayBeLive: runtimeMayBeLive } : {}),
    });
    this.releaseExternalClaim(claim);
  }

  private releaseExternalClaim(claim: ExternalAppRuntimeClaim): void {
    this.externalClaims.delete(invocationRegistryKey(claim.invocationRef));
    const claims = this.externalClaimsByApp.get(claim.appId);
    claims?.delete(claim.invocationRef.operationId);
    if (claims?.size === 0) {
      this.externalClaimsByApp.delete(claim.appId);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForAppReady(
  appId: number,
  timeoutMs = DEFAULT_APP_READY_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const appInfo = runningApps.get(appId);
    if (!appInfo) {
      throw new DyadError(
        "The app process exited before the preview became ready. The dev app crashed before its " +
          "preview was up — commonly caused by low system memory or a dev-server startup failure. " +
          "Check the app's logs, free up memory, and retry.",
        DyadErrorKind.External,
      );
    }
    if (appInfo.proxyUrl) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, APP_READY_POLL_MS);
    });
  }
  // Check if a compilation error was detected during startup
  const appInfo = runningApps.get(appId);
  const compilationErr = appInfo?.compilationError;
  throw new DyadError(
    compilationErr
      ? `Preview failed: ${compilationErr.summary}. The agent has been notified and can fix this automatically.`
      : "Timed out waiting for the app preview to become ready",
    DyadErrorKind.External,
  );
}

export const appRuntimeService = new AppRuntimeService({
  runSerialized: (appId, lifecycle, operation) =>
    appOperationCoordinator.run(
      {
        appId,
        operation: `app-runtime:${lifecycle}`,
        resources: getAppRuntimeOperationResources(lifecycle),
      },
      operation,
    ),
  findApp: (appId) =>
    db.query.apps.findFirst({
      where: eq(apps.id, appId),
    }),
  resolveAppPath: getDyadAppPath,
  getRunningApp: (appId) => runningApps.get(appId),
  deleteRunningApp: (appId) => {
    runningApps.delete(appId);
  },
  getProcessCounter: () => processCounter.value,
  startProcess: executeApp,
  stopProcess: stopAppByInfo,
  removeCurrentProcess: removeAppIfCurrentProcess,
  cleanPort: cleanUpPort,
  restartSandbox: restartCloudSandbox,
  ensureProxy: ensureProxyForRunningApp,
  startCloudLogs: startCloudSandboxLogStream,
  clearLogs,
  readRuntimeMode: () => readSettings().runtimeMode2 ?? "host",
  removeNodeModules: async (appPath) => {
    await removeNodeModulesWithRetry(path.join(appPath, "node_modules"));
  },
  removeDockerVolumes: removeDockerVolumesForApp,
  waitForReady: waitForAppReady,
  createId: randomUUID,
  now: Date.now,
});
