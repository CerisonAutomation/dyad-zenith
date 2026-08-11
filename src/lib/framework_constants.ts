export const APP_FRAMEWORK_TYPES = [
  "nextjs",
  "vite",
  "vite-nitro",
  "astro",
  "sveltekit",
  "remix",
  "nuxt",
  "expo",
  "static",
  "other",
] as const;
export type AppFrameworkType = (typeof APP_FRAMEWORK_TYPES)[number];

export const NEXTJS_CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
];

export const VITE_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

export const ASTRO_CONFIG_FILES = [
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.cjs",
  "astro.config.ts",
  "astro.config.mts",
];

export const REMIX_CONFIG_FILES = [
  "remix.config.js",
  "remix.config.mjs",
  "remix.config.cjs",
  "remix.config.ts",
];

export const NUXT_CONFIG_FILES = [
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.cjs",
  "nuxt.config.ts",
];

export const SVELTEKIT_CONFIG_FILES = [
  "svelte.config.js",
  "svelte.config.mjs",
  "svelte.config.cjs",
  "svelte.config.ts",
];

export const EXPO_CONFIG_FILES = [
  "app.json",
  "app.config.js",
  "app.config.ts",
  "expo-env.d.ts",
];

/** Framework-specific production build command (run from the app root). */
export function getFrameworkBuildCommand(
  frameworkType: AppFrameworkType | null | undefined,
): string | null {
  switch (frameworkType) {
    case "nextjs":
      return "next build";
    case "vite":
    case "vite-nitro":
      return "vite build";
    case "astro":
      return "astro build";
    case "sveltekit":
      return "svelte-kit sync && vite build";
    case "remix":
      return "remix build";
    case "nuxt":
      return "nuxt build";
    case "expo":
      return "npx expo export --platform web";
    case "static":
      return null; // nothing to build — serve the files directly
    default:
      return "npm run build";
  }
}

/**
 * Whether the dev server should receive a `--port` flag (known framework
 * CLIs), a PORT env var (custom node/tsx/express servers), or neither (no
 * dev script). Custom servers that ignore `--port` would otherwise bind the
 * default port while Dyad polls the allocated one — a blank preview.
 */
export function getFrameworkDevPortStrategy(
  devScript: string | undefined,
  frameworkType: AppFrameworkType | null | undefined,
): "flag" | "env" | "script" {
  if (!devScript) {
    // Only genuine static sites (no framework, no dev script) get the serve
    // fallback. Everything else keeps the legacy `run dev -- --port` shape.
    return frameworkType === "static" ? "script" : "flag";
  }
  const lower = devScript.toLowerCase();
  const knownFlagCli =
    lower.includes("next dev") ||
    lower.includes("vite") ||
    lower.includes("astro dev") ||
    lower.includes("nuxt dev") ||
    lower.includes("remix dev") ||
    lower.includes("svelte-kit") ||
    lower.includes("sveltekit");
  if (knownFlagCli) return "flag";
  if (
    frameworkType === "nextjs" ||
    frameworkType === "vite" ||
    frameworkType === "vite-nitro" ||
    frameworkType === "astro" ||
    frameworkType === "nuxt" ||
    frameworkType === "sveltekit" ||
    frameworkType === "remix"
  ) {
    return "flag";
  }
  return "env";
}

/**
 * Whether Neon can be connected to this app. Neon supports Next.js and Vite
 * apps (Vite apps automatically get a Nitro server layer added on connect).
 */
export function isNeonSupportedFramework({
  files,
  frameworkType,
}: {
  files?: string[];
  frameworkType?: AppFrameworkType | null;
}): boolean {
  if (frameworkType) {
    return (
      frameworkType === "nextjs" ||
      frameworkType === "vite" ||
      frameworkType === "vite-nitro"
    );
  }

  if (!files) return false;
  return files.some(
    (file) =>
      NEXTJS_CONFIG_FILES.includes(file) || VITE_CONFIG_FILES.includes(file),
  );
}
