/**
 * Dev server detection utilities.
 *
 * Scans for already-running development servers so Dyad can attach to them
 * instead of spawning a new one. Adopted from patterns used by Cursor, Bolt,
 * and Replit — the industry standard is to detect existing servers first.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { createServer } from "node:net";

/** Known dev-server port ranges per framework. */
const DEV_PORT_HINTS: Record<string, number[]> = {
  nextjs: [3000, 3001, 3002, 3003],
  vite: [5173, 5174, 5175, 3000],
  astro: [4321, 4322, 3000],
  nuxt: [3000, 3001, 3002],
  remix: [3000, 3001],
  sveltekit: [5173, 5174, 3000],
  expo: [8081, 19000, 19001],
  "vite-nitro": [3000, 5173],
  static: [],
  other: [3000, 8000, 8080, 3001, 5173],
};

export interface DetectedServer {
  port: number;
  url: string;
  framework: string;
  pid?: number;
  processName?: string;
}

/**
 * Check if a port is currently listening (accepts connections).
 */
async function isPortActive(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://localhost:${port}`,
      { timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Find a free port starting from the given port, scanning upward.
 */
export async function findFreePort(
  startPort: number,
  maxAttempts = 100,
): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.unref();
      server.on("error", () => resolve(false));
      server.listen(port, "localhost", () => {
        server.close(() => resolve(true));
      });
    });
    if (free) return port;
  }
  return startPort; // fallback
}

/**
 * Scan known ports for a framework to find an already-running dev server.
 * Returns the first active server found, or null if none are running.
 */
export async function detectExistingDevServer(
  frameworkType: string | null,
  appPath?: string,
): Promise<DetectedServer | null> {
  const hints = frameworkType
    ? DEV_PORT_HINTS[frameworkType] ?? DEV_PORT_HINTS.other
    : DEV_PORT_HINTS.other;

  // Try each hint port
  for (const port of hints) {
    if (await isPortActive(port, 1500)) {
      // Found a server — try to identify what it is
      let processName: string | undefined;
      try {
        const lsof = execFileSync(
          "lsof",
          [`-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"],
          { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
        );
        const nameMatch = lsof.match(/n(\S+)/);
        processName = nameMatch?.[1];
      } catch {
        // lsof may fail or timeout
      }

      return {
        port,
        url: `http://localhost:${port}`,
        framework: frameworkType ?? "unknown",
        processName,
      };
    }
  }

  // If appPath is given, also scan for port mentioned in .env or config
  if (appPath) {
    try {
      const { readFileSync, existsSync } = require("node:fs");
      const { join } = require("node:path");
      const envPath = join(appPath, ".env.local");
      if (existsSync(envPath)) {
        const env = readFileSync(envPath, "utf8");
        const portMatch = env.match(/PORT\s*=\s*(\d{4,5})/);
        if (portMatch) {
          const envPort = parseInt(portMatch[1], 10);
          if (await isPortActive(envPort, 1500)) {
            return {
              port: envPort,
              url: `http://localhost:${envPort}`,
              framework: frameworkType ?? "unknown",
            };
          }
        }
      }
    } catch {
      // ignore scan errors
    }
  }

  return null;
}
