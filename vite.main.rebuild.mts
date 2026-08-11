// One-shot rebuild of ONLY the Electron main-process target, replicating
// @electron-forge/plugin-vite's getConfig() merge for the "main" build:
//   build.lib = { entry, fileName: () => '[name].js', formats: ['cjs'] }
//   build.outDir = '.vite/build', emptyOutDir: false, minify: true
// Usage: npx vite build --config vite.main.rebuild.mts
import { defineConfig, mergeConfig } from "vite";
import userConfig from "./vite.main.config.mts";

const forgeExternals = ["electron", "electron/common", "electron/main"];

export default defineConfig(
  mergeConfig(
    {
      configFile: false,
      clearScreen: false,
      build: {
        copyPublicDir: false,
        outDir: ".vite/build",
        emptyOutDir: false,
        minify: true,
        lib: {
          entry: "src/main.ts",
          fileName: () => "[name].js",
          formats: ["cjs"],
        },
        rollupOptions: {
          // Forge's plugin base config externalizes electron + node builtins.
          // The user config's external list (nodeBuiltins + native modules)
          // must ALSO include electron, or electron's index.js gets bundled
          // and throws "Electron failed to install correctly" at runtime.
          external: [
            ...forgeExternals,
            ...((userConfig as { build?: { rollupOptions?: { external?: unknown[] } } })
              .build?.rollupOptions?.external as unknown[] | undefined ?? []),
          ],
        },
      },
      resolve: {
        // Forge's main-target config: force Node.js condition resolution so
        // dual-package deps (e.g. electron-log) load their Node build, not the
        // renderer build (which references `window` and crashes the main process).
        conditions: ["node"],
        mainFields: ["module", "jsnext:main", "jsnext"],
      },
    },
    userConfig as Record<string, unknown>,
  ),
);
