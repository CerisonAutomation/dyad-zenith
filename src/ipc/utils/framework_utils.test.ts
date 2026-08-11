import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectFrameworkType,
  detectNextJsMajorVersion,
} from "./framework_utils";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

describe("detectFrameworkType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects Next.js from next.config.cjs", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("next.config.cjs"),
    );

    expect(detectFrameworkType("/tmp/example-app")).toBe("nextjs");
  });

  it("detects Next.js from package.json when no config file exists", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        dependencies: {
          next: "^15.0.0",
        },
      }),
    );

    expect(detectFrameworkType("/tmp/example-app")).toBe("nextjs");
  });

  it("detects Vite from package.json when no config file exists", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        devDependencies: {
          vite: "^7.0.0",
        },
      }),
    );

    expect(detectFrameworkType("/tmp/example-app")).toBe("vite");
  });

  it("detects Astro from package.json deps", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { astro: "^5.0.0" } }),
    );
    expect(detectFrameworkType("/tmp/astro-app")).toBe("astro");
  });

  it("detects Nuxt from nuxt.config.ts", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("nuxt.config.ts"),
    );
    expect(detectFrameworkType("/tmp/nuxt-app")).toBe("nuxt");
  });

  it("detects Remix from @remix-run/react dep", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { "@remix-run/react": "^2.0.0" } }),
    );
    expect(detectFrameworkType("/tmp/remix-app")).toBe("remix");
  });

  it("detects SvelteKit from @sveltejs/kit dep", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { "@sveltejs/kit": "^2.0.0" } }),
    );
    expect(detectFrameworkType("/tmp/svelte-app")).toBe("sveltekit");
  });

  it("detects Expo from expo dep + app.json", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const s = String(candidate);
      return s.endsWith("package.json") || s.endsWith("app.json");
    });
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { expo: "^53.0.0" } }),
    );
    expect(detectFrameworkType("/tmp/expo-app")).toBe("expo");
  });

  it("detects static sites from a root index.html with no framework signals", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const s = String(candidate);
      return s.endsWith("index.html");
    });
    expect(detectFrameworkType("/tmp/static-site")).toBe("static");
  });

  it("does not misdetect a Next.js app with a root index.html as static", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const s = String(candidate);
      return s.endsWith("package.json") || s.endsWith("index.html");
    });
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    );
    expect(detectFrameworkType("/tmp/next-with-index")).toBe("nextjs");
  });

  it("falls back to other for unknown projects", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    );
    expect(detectFrameworkType("/tmp/express-app")).toBe("other");
  });
});

describe("detectNextJsMajorVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the major version from a caret range", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { next: "^15.1.2" } }),
    );

    expect(detectNextJsMajorVersion("/tmp/example-app")).toBe(15);
  });

  it("returns the major version from an exact version", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ devDependencies: { next: "16.0.0" } }),
    );

    expect(detectNextJsMajorVersion("/tmp/example-app")).toBe(16);
  });

  it("returns null when next is missing", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: {} }),
    );

    expect(detectNextJsMajorVersion("/tmp/example-app")).toBeNull();
  });

  it("returns null for non-numeric versions like 'latest'", () => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      String(candidate).endsWith("package.json"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { next: "latest" } }),
    );

    expect(detectNextJsMajorVersion("/tmp/example-app")).toBeNull();
  });

  it("returns null when package.json does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(detectNextJsMajorVersion("/tmp/example-app")).toBeNull();
  });
});
