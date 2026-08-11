import { describe, expect, it } from "vitest";
import {
  getFrameworkBuildCommand,
  getFrameworkDevPortStrategy,
} from "@/lib/framework_constants";

describe("getFrameworkBuildCommand", () => {
  it("maps every supported framework to its production build command", () => {
    expect(getFrameworkBuildCommand("nextjs")).toBe("next build");
    expect(getFrameworkBuildCommand("vite")).toBe("vite build");
    expect(getFrameworkBuildCommand("vite-nitro")).toBe("vite build");
    expect(getFrameworkBuildCommand("astro")).toBe("astro build");
    expect(getFrameworkBuildCommand("sveltekit")).toBe(
      "svelte-kit sync && vite build",
    );
    expect(getFrameworkBuildCommand("remix")).toBe("remix build");
    expect(getFrameworkBuildCommand("nuxt")).toBe("nuxt build");
    expect(getFrameworkBuildCommand("expo")).toBe(
      "npx expo export --platform web",
    );
  });

  it("returns null for static sites (nothing to build)", () => {
    expect(getFrameworkBuildCommand("static")).toBeNull();
  });

  it("falls back to npm run build for unknown frameworks", () => {
    expect(getFrameworkBuildCommand("other")).toBe("npm run build");
    expect(getFrameworkBuildCommand(null)).toBe("npm run build");
  });
});

describe("getFrameworkDevPortStrategy", () => {
  it("uses the --port flag for known framework CLIs", () => {
    expect(getFrameworkDevPortStrategy("next dev", "nextjs")).toBe("flag");
    expect(getFrameworkDevPortStrategy("vite", "vite")).toBe("flag");
    expect(getFrameworkDevPortStrategy("astro dev --host", "astro")).toBe(
      "flag",
    );
  });

  it("uses the --port flag for detected frameworks even with custom scripts", () => {
    expect(getFrameworkDevPortStrategy("tsx src/entry.ts", "nextjs")).toBe(
      "flag",
    );
  });

  it("uses PORT env for custom servers on unknown frameworks", () => {
    expect(getFrameworkDevPortStrategy("tsx server.ts", "other")).toBe("env");
    expect(getFrameworkDevPortStrategy("node index.js", null)).toBe("env");
  });

  it("uses the serve fallback only for static sites without a dev script", () => {
    expect(getFrameworkDevPortStrategy(undefined, "static")).toBe("script");
    expect(getFrameworkDevPortStrategy("", "static")).toBe("script");
    // Legacy behavior for non-static apps without a dev script.
    expect(getFrameworkDevPortStrategy("", "other")).toBe("flag");
    expect(getFrameworkDevPortStrategy(undefined, "nextjs")).toBe("flag");
  });
});
