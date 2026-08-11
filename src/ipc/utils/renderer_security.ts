import type { IpcMainInvokeEvent } from "electron";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

type RendererTrustPolicy = {
  devServerOrigin: string | null;
  packagedRendererProtocol: string | null;
  packagedRendererHost: string | null;
  packagedRendererEntryPath: string | null;
  packagedRendererVolumePrefix: string;
};

let trustPolicy: RendererTrustPolicy = {
  devServerOrigin: null,
  packagedRendererProtocol: null,
  packagedRendererHost: null,
  packagedRendererEntryPath: null,
  packagedRendererVolumePrefix: "",
};

function rendererTrustPoliciesMatch(
  left: RendererTrustPolicy,
  right: RendererTrustPolicy,
): boolean {
  return (
    left.devServerOrigin === right.devServerOrigin &&
    left.packagedRendererProtocol === right.packagedRendererProtocol &&
    left.packagedRendererHost === right.packagedRendererHost &&
    left.packagedRendererEntryPath === right.packagedRendererEntryPath &&
    left.packagedRendererVolumePrefix === right.packagedRendererVolumePrefix
  );
}

// TanStack Router uses the browser history API. In a packaged file:// build,
// root-relative routes therefore appear as file:///, file:///chat, etc. Keep
// this list aligned with src/router.ts so an arbitrary local file path is not
// mistaken for a renderer route.
const PACKAGED_RENDERER_STATIC_PATHS = new Set([
  "/",
  "/app-details",
  "/apps",
  "/chat",
  "/library",
  "/library/media",
  "/library/prompts",
  "/library/themes",
  "/plugins",
  "/settings",
  "/templates",
]);

function getFileVolumePrefix(pathname: string): string {
  return pathname.match(/^\/[a-z]:/i)?.[0].toLowerCase() ?? "";
}

function isPackagedRendererRoutePath(
  pathname: string,
  volumePrefix: string,
): boolean {
  if (
    volumePrefix &&
    pathname.slice(0, volumePrefix.length).toLowerCase() !== volumePrefix
  ) {
    return false;
  }
  const routePath = volumePrefix
    ? pathname.slice(volumePrefix.length)
    : pathname;
  const normalizedPath =
    routePath.length > 1 && routePath.endsWith("/")
      ? routePath.slice(0, -1)
      : routePath;
  return (
    PACKAGED_RENDERER_STATIC_PATHS.has(normalizedPath) ||
    /^\/providers\/[^/]+$/.test(normalizedPath) ||
    // Provider settings pages are nested under /settings (e.g.
    // file:///settings/providers/opencode). Keep this aligned with
    // src/routes/settings/providers/$provider.tsx.
    /^\/settings\/providers\/[^/]+$/.test(normalizedPath) ||
    // Plugin detail pages use numeric server ids.
    /^\/plugins\/\d+$/.test(normalizedPath)
  );
}

export function configureTrustedRenderer(options: {
  devServerUrl?: string;
  packagedRendererUrl: string;
}): void {
  const packagedRenderer = new URL(options.packagedRendererUrl);
  if (packagedRenderer.protocol !== "file:" || packagedRenderer.host !== "") {
    throw new Error(
      "The packaged renderer URL must be a local file URL with an empty host.",
    );
  }
  let devServerOrigin: string | null = null;
  if (options.devServerUrl) {
    devServerOrigin = new URL(options.devServerUrl).origin;
  }
  const nextTrustPolicy: RendererTrustPolicy = {
    devServerOrigin,
    packagedRendererProtocol: packagedRenderer.protocol,
    packagedRendererHost: packagedRenderer.host,
    packagedRendererEntryPath: packagedRenderer.pathname,
    packagedRendererVolumePrefix: getFileVolumePrefix(
      packagedRenderer.pathname,
    ),
  };
  if (
    trustPolicy.packagedRendererProtocol !== null &&
    process.env.NODE_ENV !== "test" &&
    !rendererTrustPoliciesMatch(trustPolicy, nextTrustPolicy)
  ) {
    throw new Error("The renderer trust policy cannot be reconfigured.");
  }
  trustPolicy = nextTrustPolicy;
}

export function isTrustedRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      return (
        parsed.protocol === trustPolicy.packagedRendererProtocol &&
        parsed.host === "" &&
        parsed.host === trustPolicy.packagedRendererHost &&
        (parsed.pathname === trustPolicy.packagedRendererEntryPath ||
          isPackagedRendererRoutePath(
            parsed.pathname,
            trustPolicy.packagedRendererVolumePrefix,
          ))
      );
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      // Normalize localhost <-> 127.0.0.1 so the dev-server origin check
      // doesn't fail when the renderer was loaded via a different loopback
      // host than the one baked into MAIN_WINDOW_VITE_DEV_SERVER_URL.
      return (
        parsed.origin === trustPolicy.devServerOrigin ||
        (isLoopbackHost(parsed.hostname) &&
          trustPolicy.devServerOrigin !== null &&
          parsed.port === new URL(trustPolicy.devServerOrigin).port &&
          parsed.protocol === new URL(trustPolicy.devServerOrigin).protocol &&
          isLoopbackHost(new URL(trustPolicy.devServerOrigin).hostname))
      );
    }
    return false;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function isSenderMainFrame(event: IpcMainInvokeEvent): boolean {
  const senderFrame = event.senderFrame;
  if (!senderFrame) {
    return false;
  }

  const mainFrame = event.sender.mainFrame;
  if (senderFrame === mainFrame) {
    return true;
  }

  // Electron can expose distinct WebFrameMain wrapper objects for the same
  // underlying frame. processId + routingId is the stable frame identity;
  // routingId is unique within its renderer process. Keep the parent check so
  // a child frame can never pass even if a malformed event reuses identifiers.
  return (
    senderFrame.parent === null &&
    Number.isInteger(senderFrame.processId) &&
    Number.isInteger(senderFrame.routingId) &&
    senderFrame.processId === mainFrame.processId &&
    senderFrame.routingId === mainFrame.routingId
  );
}

export function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (trustPolicy.packagedRendererProtocol === null) {
    throw new DyadError(
      "Renderer trust policy is not configured. Call configureTrustedRenderer() before handling IPC.",
      DyadErrorKind.Internal,
    );
  }
  const frame = event.senderFrame;
  if (!frame || !isSenderMainFrame(event) || !isTrustedRendererUrl(frame.url)) {
    // Include diagnostics so an untrusted frame can be identified from logs.
    throw new DyadError(
      `IPC requests must originate from the trusted Dyad renderer. (senderFrameUrl=${frame?.url ?? "<none>"}, isMainFrame=${isSenderMainFrame(event)}, trustedRoutes=${PACKAGED_RENDERER_STATIC_PATHS.size}+regex, policy=${trustPolicy.packagedRendererProtocol}//${trustPolicy.packagedRendererEntryPath})`,
      DyadErrorKind.Validation,
    );
  }
}
