import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import {
  buildAppTool,
  resolveBuildCommandForApp,
} from "./build_app";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

function mockFs(exists: (candidate: string) => boolean, pkg?: object): void {
  vi.mocked(fs.existsSync).mockImplementation((candidate) =>
    exists(String(candidate)),
  );
  vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
    const s = String(candidate);
    if (s.endsWith("package.json")) {
      return JSON.stringify(
        pkg ?? { scripts: { dev: "next dev" }, dependencies: { next: "^15" } },
      );
    }
    return "";
  });
}

describe("resolveBuildCommandForApp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a Next.js app to next build", () => {
    mockFs((c) => c.endsWith("package.json"));
    expect(resolveBuildCommandForApp("/tmp/next-app")).toBe("next build");
  });

  it("maps a Vite app to vite build", () => {
    mockFs(
      (c) => c.endsWith("package.json") || c.endsWith("vite.config.ts"),
      { scripts: { dev: "vite" }, devDependencies: { vite: "^7" } },
    );
    expect(resolveBuildCommandForApp("/tmp/vite-app")).toBe("vite build");
  });

  it("maps Astro, Nuxt, Remix, SvelteKit and Expo to their builds", () => {
    mockFs((c) => c.endsWith("package.json"), {
      dependencies: { astro: "^5" },
    });
    expect(resolveBuildCommandForApp("/tmp/a")).toBe("astro build");

    mockFs((c) => c.endsWith("package.json"), {
      dependencies: { nuxt: "^3" },
    });
    expect(resolveBuildCommandForApp("/tmp/n")).toBe("nuxt build");

    mockFs((c) => c.endsWith("package.json"), {
      dependencies: { "@remix-run/react": "^2" },
    });
    expect(resolveBuildCommandForApp("/tmp/r")).toBe("remix build");

    mockFs((c) => c.endsWith("package.json"), {
      dependencies: { "@sveltejs/kit": "^2" },
    });
    expect(resolveBuildCommandForApp("/tmp/s")).toBe(
      "svelte-kit sync && vite build",
    );

    mockFs((c) => c.endsWith("package.json") || c.endsWith("app.json"), {
      dependencies: { expo: "^53" },
    });
    expect(resolveBuildCommandForApp("/tmp/e")).toBe(
      "npx expo export --platform web",
    );
  });

  it("returns null for static sites (no build step)", () => {
    mockFs((c) => c.endsWith("index.html"));
    expect(resolveBuildCommandForApp("/tmp/static")).toBeNull();
  });

  it("falls back to npm run build for unknown frameworks", () => {
    mockFs((c) => c.endsWith("package.json"), {
      dependencies: { express: "^4" },
    });
    expect(resolveBuildCommandForApp("/tmp/other")).toBe("npm run build");
  });
});

describe("buildAppTool", () => {
  it("exposes a consent preview and a compact description", () => {
    expect(buildAppTool.name).toBe("build_app");
    expect(buildAppTool.modifiesState).toBe(true);
    expect(buildAppTool.defaultConsent).toBe("ask");
    expect(buildAppTool.inputSchema.safeParse({ command: "rm -rf ." }).success).toBe(false);
    expect(buildAppTool.getConsentPreview?.({})).toContain(
      "production build",
    );
    expect(buildAppTool.description).toContain("Next.js");
    expect(buildAppTool.description).toContain("detected framework");
    expect(buildAppTool.description).toContain("Custom shell commands");
  });

  it("returns the no-build message for static apps", async () => {
    mockFs((c) => c.endsWith("index.html"));
    const result = await buildAppTool.execute?.(
      {},
      { appPath: "/tmp/static", abortSignal: undefined } as never,
    );
    expect(result).toContain("static site");
  });
});
