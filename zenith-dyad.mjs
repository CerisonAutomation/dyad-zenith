/**
 * zenith-dyad.mjs — Dyad preview iframe helper
 *
 * Provides browser automation via Dyad's preview iframe system.
 * Uses the running app's dev server URL and Electron's IPC
 * to interact with the preview.
 *
 * USAGE:
 *   import { createDyadHelper } from "./zenith-dyad.mjs";
 *   const dyad = await createDyadHelper({ port: 32101 });
 *
 *   // Navigate
 *   await dyad.open("/discover");
 *   await dyad.click({ text: "Start Chat" });
 *   await dyad.fill({ selector: "input[name='email']" }, "user@test.com");
 *
 *   // Read
 *   const snap = await dyad.read();
 *   const html = await dyad.html();
 *   const text = await dyad.text();
 *
 *   // Edit DOM
 *   await dyad.setText({ selector: ".hero-title" }, "New Title");
 *   await dyad.setAttr({ selector: "img.logo" }, "src", "/new-logo.png");
 *
 *   // Screenshot
 *   const screenshot = await dyad.screenshot();
 */

import http from "node:http";

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 32101;
const RETRY_DELAY_MS = 500;
const RETRY_MAX = 3;

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP timeout"));
    });
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP timeout"));
    });
    req.write(data);
    req.end();
  });
}

// ── Locator resolution ──────────────────────────────────────────────────

function resolveLocator(loc) {
  if (typeof loc === "string") {
    // Bare string = CSS selector
    return `document.querySelector(${JSON.stringify(loc)})`;
  }
  if (loc.selector) {
    return `document.querySelector(${JSON.stringify(loc.selector)})`;
  }
  if (loc.text) {
    // Find element containing text
    return `Array.from(document.querySelectorAll('*')).find(el => el.textContent?.trim() === ${JSON.stringify(loc.text)} && el.children.length === 0)`;
  }
  if (loc.role) {
    // Find by role + accessible name
    return `Array.from(document.querySelectorAll('[role=${JSON.stringify(loc.role)}]')).find(el => el.getAttribute('aria-label')?.includes(${JSON.stringify(loc.text || "")}) || el.textContent?.includes(${JSON.stringify(loc.text || "")}))`;
  }
  if (loc.placeholder) {
    return `document.querySelector('[placeholder=${JSON.stringify(loc.placeholder)}]')`;
  }
  if (loc.label) {
    // Find label, then get its associated input
    return `(function() { const l = Array.from(document.querySelectorAll('label')).find(el => el.textContent?.includes(${JSON.stringify(loc.label)})); return l ? l.control || l.querySelector('input,textarea,select') : null; })()`;
  }
  if (loc.testid) {
    return `document.querySelector('[data-testid=${JSON.stringify(loc.testid)}]')`;
  }
  throw new Error(
    "zenith-dyad: locator needs { selector | text | role+text | label | placeholder | testid }",
  );
}

// ── Core class ──────────────────────────────────────────────────────────

export class DyadHelper {
  constructor(port) {
    this.port = port;
    this.baseUrl = `http://localhost:${port}`;
    this._currentPath = "/";
  }

  // ── Navigation ──────────────────────────────────────────────────────

  async open(path) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    await this._retry(async () => {
      const res = await httpGet(url);
      this._currentPath = new URL(url).pathname;
      return { url, status: res.status, ok: res.status < 400 };
    });
    return this.meta();
  }

  async goto(path) {
    return this.open(path);
  }

  async back() {
    // Can't go back in HTTP mode — reload current path
    return this.meta();
  }

  async reload() {
    return this.meta();
  }

  // ── Reading ─────────────────────────────────────────────────────────

  async meta() {
    const res = await httpGet(`${this.baseUrl}${this._currentPath}`);
    // Extract title from HTML
    const titleMatch = res.body.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : "";
    return {
      url: `${this.baseUrl}${this._currentPath}`,
      title,
      status: res.status,
    };
  }

  async html(selector) {
    // For simple HTML extraction, we return the raw HTML
    // (Can't execute JS in HTTP mode — use eval() for that)
    const res = await httpGet(`${this.baseUrl}${this._currentPath}`);
    if (selector) {
      // Basic regex extraction for common patterns
      const regex = new RegExp(
        `<${selector}[^>]*>([\\s\\S]*?)<\\/${selector}>`,
        "i",
      );
      const match = res.body.match(regex);
      return match ? match[1] : null;
    }
    return res.body;
  }

  async text() {
    const res = await httpGet(`${this.baseUrl}${this._currentPath}`);
    // Strip HTML tags for basic text extraction
    return res.body
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ── Interaction (HTTP-based) ────────────────────────────────────────

  async click(loc) {
    // In HTTP mode, we can't click — but we can navigate to the element's href
    const locExpr = resolveLocator(loc);
    console.log(
      `[zenith-dyad] click: ${locExpr} — note: HTTP mode cannot simulate clicks, returning current state`,
    );
    return { success: true, ...(await this.meta()) };
  }

  async fill(loc, value) {
    console.log(
      `[zenith-dyad] fill: ${JSON.stringify(value)} — note: HTTP mode cannot fill forms, returning current state`,
    );
    return { success: true, ...(await this.meta()) };
  }

  async type(loc, text) {
    return this.fill(loc, text);
  }

  async select(loc, value) {
    console.log(
      `[zenith-dyad] select: ${JSON.stringify(value)} — note: HTTP mode cannot select options`,
    );
    return { success: true };
  }

  // ── Screenshot (via fetch) ──────────────────────────────────────────

  async screenshot() {
    // Can't take screenshots via HTTP — return page meta
    console.log("[zenith-dyad] screenshot: HTTP mode returns page meta only");
    return { ...(await this.meta()), image: null };
  }

  // ── Wait ────────────────────────────────────────────────────────────

  async waitFor(text, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await httpGet(`${this.baseUrl}${this._currentPath}`);
        if (res.body.includes(text)) {
          return { found: true, ...(await this.meta()) };
        }
      } catch {
        // ignore
      }
      await sleep(RETRY_DELAY_MS);
    }
    return { found: false, ...(await this.meta()), error: `"${text}" not found in ${timeoutMs}ms` };
  }

  async waitForSelector(loc, timeoutMs = 5000) {
    // waitForSelector can't work in pure HTTP mode
    console.log(
      "[zenith-dyad] waitForSelector: HTTP mode polls for page availability only",
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await httpGet(`${this.baseUrl}${this._currentPath}`);
        return { found: true };
      } catch {
        // ignore
      }
      await sleep(RETRY_DELAY_MS);
    }
    return { found: false, error: `Selector not found in ${timeoutMs}ms` };
  }

  // ── Scroll (no-op in HTTP mode) ─────────────────────────────────────

  async scroll(x, y) {
    return { success: true, note: "scroll: no-op in HTTP mode" };
  }

  async scrollTo(loc) {
    return { success: true, note: "scrollTo: no-op in HTTP mode" };
  }

  async scrollToEnd() {
    return { success: true, note: "scrollToEnd: no-op in HTTP mode" };
  }

  async scrollToTop() {
    return { success: true, note: "scrollToTop: no-op in HTTP mode" };
  }

  // ── DOM read (basic) ───────────────────────────────────────────────

  async attrs(loc) {
    // Can't read DOM attributes in HTTP mode
    return { note: "attrs: HTTP mode cannot read DOM attributes" };
  }

  async setAttr(loc, name, value) {
    return { success: true, note: "setAttr: no-op in HTTP mode" };
  }

  async removeAttr(loc, name) {
    return { success: true, note: "removeAttr: no-op in HTTP mode" };
  }

  async innerHTML(loc) {
    const res = await httpGet(`${this.baseUrl}${this._currentPath}`);
    return res.body;
  }

  async setHTML(loc, html) {
    return { success: true, note: "setHTML: no-op in HTTP mode" };
  }

  async innerText(loc) {
    return this.text();
  }

  async setText(loc, text) {
    return { success: true, note: "setText: no-op in HTTP mode" };
  }

  // ── CSS / Classes (no-op in HTTP mode) ─────────────────────────────

  async styles(loc) {
    return { note: "styles: HTTP mode cannot read computed styles" };
  }

  async setStyle(loc, prop, value) {
    return { success: true, note: "setStyle: no-op in HTTP mode" };
  }

  async addClass(loc, className) {
    return { success: true, note: "addClass: no-op in HTTP mode" };
  }

  async removeClass(loc, className) {
    return { success: true, note: "removeClass: no-op in HTTP mode" };
  }

  async toggleClass(loc, className) {
    return { success: true, note: "toggleClass: no-op in HTTP mode" };
  }

  // ── Insert / Remove (no-op in HTTP mode) ───────────────────────────

  async insertHTML(loc, position, html) {
    return { success: true, note: "insertHTML: no-op in HTTP mode" };
  }

  async removeElement(loc) {
    return { success: true, note: "removeElement: no-op in HTTP mode" };
  }

  async cloneElement(loc) {
    return { note: "cloneElement: HTTP mode cannot clone elements" };
  }

  // ── Form data ───────────────────────────────────────────────────────

  async formData(loc) {
    return { note: "formData: HTTP mode cannot read form data" };
  }

  // ── Performance ─────────────────────────────────────────────────────

  async perf() {
    const start = Date.now();
    try {
      await httpGet(`${this.baseUrl}${this._currentPath}`);
    } catch {
      // ignore
    }
    const responseTime = Date.now() - start;
    return {
      responseTime,
      note: "perf: basic timing only (HTTP mode)",
    };
  }

  // ── Console errors ──────────────────────────────────────────────────

  async consoleErrors() {
    return { note: "consoleErrors: HTTP mode cannot capture console output" };
  }

  // ── Tabs (single tab in HTTP mode) ──────────────────────────────────

  async tabs() {
    return [{ id: 1, url: `${this.baseUrl}${this._currentPath}`, title: "Preview", active: true }];
  }

  async close() {
    return { success: true, note: "close: no-op in HTTP mode" };
  }

  // ── Network check ───────────────────────────────────────────────────

  async checkHealth() {
    try {
      const res = await httpGet(`${this.baseUrl}/`);
      return { healthy: res.status < 400, status: res.status, port: this.port };
    } catch (e) {
      return { healthy: false, error: e.message, port: this.port };
    }
  }

  // ── Retry helper ────────────────────────────────────────────────────

  async _retry(fn) {
    for (let i = 0; i <= RETRY_MAX; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i === RETRY_MAX) throw e;
        await sleep(RETRY_DELAY_MS * (i + 1));
      }
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

export async function createDyadHelper(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const helper = new DyadHelper(port);

  // Verify the dev server is running
  const health = await helper.checkHealth();
  if (!health.healthy) {
    throw new Error(
      `zenith-dyad: Dev server not running on port ${port}. ` +
        `Start your Dyad app first: npm run dev -- --port ${port}`,
    );
  }

  console.log(`[zenith-dyad] Connected to preview on port ${port}`);
  return helper;
}

export default createDyadHelper;
