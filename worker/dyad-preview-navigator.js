/**
 * Dyad Preview Navigator — injected into the preview iframe.
 *
 * Provides browser-automation-like capabilities:
 *  - takeScreenshot()      → full-page or viewport capture via html-to-image
 *  - navigate(url)         → change iframe location
 *  - click(selector)       → click an element
 *  - typeText(selector, t) → fill an input
 *  - getText(selector)     → read visible text
 *  - eval(js)              → run arbitrary JS in the preview page
 *
 * Communication: postMessage to parent (Dyad main window).
 * All commands return { ok: true, data? } or { ok: false, error: string }.
 */

(function () {
  "use strict";

  // ── helpers ──────────────────────────────────────────────────────────────
  function send(type, payload) {
    window.parent.postMessage(
      { source: "dyad-preview-navigator", type, payload },
      "*",
    );
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  // ── screenshot via html-to-image (same approach as dyad-screenshot-client) ─
  async function takeScreenshot(opts) {
    const { fullPage = true, maxDim = 4096 } = opts || {};
    return new Promise((resolve) => {
      const reqId = uid();
      const handler = (e) => {
        if (e.data?.source === "dyad-preview-navigator" && e.data?.reqId === reqId) {
          window.removeEventListener("message", handler);
          resolve(e.data.payload);
        }
      };
      window.addEventListener("message", handler);
      send("screenshot-request", { reqId, fullPage, maxDim });
    });
  }

  // ── navigation ───────────────────────────────────────────────────────────
  function navigate(url) {
    try {
      window.location.href = url;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function currentUrl() {
    return { ok: true, data: window.location.href };
  }

  // ── DOM interaction ──────────────────────────────────────────────────────
  function click(selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: `No element found: ${selector}` };
    try {
      el.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function typeText(selector, text) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: `No element found: ${selector}` };
    try {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      nativeInputValueSetter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function getText(selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: `No element found: ${selector}` };
    return { ok: true, data: el.textContent?.trim() || "" };
  }

  function queryAll(selector) {
    const els = document.querySelectorAll(selector);
    return {
      ok: true,
      data: [...els].map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 100),
        id: el.id || null,
        className: el.className?.slice?.(0, 80) || null,
        href: el.href || null,
        visible: el.offsetParent !== null,
      })),
    };
  }

  function evalJs(code) {
    try {
      const result = eval(code);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── page info ────────────────────────────────────────────────────────────
  function pageInfo() {
    return {
      ok: true,
      data: {
        url: window.location.href,
        title: document.title,
        bodyText: (document.body?.textContent || "").trim().slice(0, 500),
        readyState: document.readyState,
        hasErrors: !!document.querySelector('[data-nextjs-error]') ||
                   (document.body?.textContent || "").includes("Application error"),
        errors: [...document.querySelectorAll('[data-nextjs-error], .next-error-h1')]
          .map((el) => el.textContent?.trim()),
      },
    };
  }

  // ── command dispatcher ───────────────────────────────────────────────────
  window.addEventListener("message", async (event) => {
    if (event.data?.source !== "dyad-preview-navigator") return;
    const { id, method, args } = event.data;
    let result;

    switch (method) {
      case "screenshot":     result = await takeScreenshot(args?.[0] || {}); break;
      case "navigate":       result = navigate(args?.[0]); break;
      case "currentUrl":     result = currentUrl(); break;
      case "click":          result = click(args?.[0]); break;
      case "typeText":       result = typeText(args?.[0], args?.[1]); break;
      case "getText":        result = getText(args?.[0]); break;
      case "queryAll":       result = queryAll(args?.[0]); break;
      case "eval":           result = evalJs(args?.[0]); break;
      case "pageInfo":       result = pageInfo(); break;
      default:               result = { ok: false, error: `Unknown method: ${method}` };
    }

    window.parent.postMessage(
      { source: "dyad-preview-navigator", id, result },
      "*",
    );
  });

  // Signal readiness to Dyad
  send("ready", { url: window.location.href });

  // Re-signal on SPA navigation (pushState/replaceState)
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    origPush.apply(this, args);
    send("navigated", { url: window.location.href });
  };
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    send("navigated", { url: window.location.href });
  };
  window.addEventListener("popstate", () => {
    send("navigated", { url: window.location.href });
  });
  window.addEventListener("hashchange", () => {
    send("navigated", { url: window.location.href });
  });
})();
