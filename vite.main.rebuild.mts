// One-shot rebuild of ONLY the Electron main-process target, replicating
// @electron-forge/plugin-vite's getConfig() merge for the "main" build:
//   build.lib = { entry, fileName: () => '[name].js', formats: ['cjs'] }
//   build.outDir = '.vite/build', emptyOutDir: false, minify: true
// Usage: npx vite build --config vite.main.rebuild.mts
import { defineConfig, mergeConfig } from "vite";
import userConfig from "./vite.main.config.mts";

export default defineConfig(
  mergeConfig(
    {
      configFile: false,
      clearScreen: false,
      build: {
        outDir: ".vite/build",
        emptyOutDir: false,
        minify: true,
        lib: {
          entry: "src/main.ts",
          fileName: () => "[name].js",
          formats: ["cjs"],
        },
      },
    },
    userConfig as Record<string, unknown>,
  ),
);
