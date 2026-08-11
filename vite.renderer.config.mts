import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const ReactCompilerConfig = {};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "posthog-js/react": path.resolve(__dirname, "./src/lib/stubs/posthog-js-react.ts"),
      "posthog-js": path.resolve(__dirname, "./src/lib/stubs/posthog-js.ts"),
    },
  },
  build: {
    rollupOptions: {
      // Bound parallel file transforms so the renderer bundle peaks lower under
      // host memory pressure (OS SIGTERMs the build otherwise). Slightly slower
      // on huge trees, dramatically lower peak RSS.
      maxParallelFileOps: 4,
    },
  },
});
