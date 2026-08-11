import { lookup } from "node:dns/promises";
import net from "node:net";
import { BrowserWindow, session } from "electron";
import log from "electron-log";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("direct_web");
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  "Mozilla/5.0 (compatible; DyadDesktop/1.0; +https://www.dyad.sh)";

export interface DirectWebPage {
  url: string;
  title?: string;
  contentType?: string;
  html: string;
  markdown: string;
}

export interface DirectSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function isBlockedIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isBlockedIpv6(ip: string): boolean {
  const value = ip.toLowerCase();
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.")
  );
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

export function normalizePublicHttpUrl(input: string): URL {
  const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new DyadError(`Invalid URL: ${input}`, DyadErrorKind.Validation);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DyadError(
      `Unsupported URL scheme: ${url.protocol}`,
      DyadErrorKind.Validation,
    );
  }
  if (url.username || url.password) {
    throw new DyadError(
      "URLs containing embedded credentials are not allowed.",
      DyadErrorKind.Validation,
    );
  }
  return url;
}

async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new DyadError(
      `Blocked non-public host: ${hostname}`,
      DyadErrorKind.Validation,
    );
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new DyadError(
        `Blocked private or reserved address: ${hostname}`,
        DyadErrorKind.Validation,
      );
    }
    return;
  }

  let records: Array<{ address: string; family: number }> = [];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new DyadError(
      `Could not resolve host: ${hostname}`,
      DyadErrorKind.External,
      { cause: error },
    );
  }
  if (!records.length || records.some((record) => isBlockedIp(record.address))) {
    throw new DyadError(
      `Blocked host resolving to a private or reserved address: ${hostname}`,
      DyadErrorKind.Validation,
    );
  }
}

async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new DyadError(
          `Web response exceeded ${Math.round(maxBytes / 1_000_000)} MB limit.`,
          DyadErrorKind.Validation,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchWithSafeRedirects(
  initialUrl: URL,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ response: Response; text: string; url: URL }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = initialUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    await assertPublicHost(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.8",
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DyadError(
          `Web request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          DyadErrorKind.External,
          { cause: error },
        );
      }
      throw new DyadError("Web request failed.", DyadErrorKind.External, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new DyadError(
          `Redirect response ${response.status} did not include a Location header.`,
          DyadErrorKind.External,
        );
      }
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      throw new DyadError(
        `Web request failed with HTTP ${response.status}.`,
        response.status === 429
          ? DyadErrorKind.RateLimited
          : DyadErrorKind.External,
      );
    }

    const text = await readResponseWithLimit(response, maxBytes);
    return { response, text, url: current };
  }

  throw new DyadError("Too many redirects.", DyadErrorKind.External);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
  };
  return value.replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (_match, entity: string) => {
      if (entity[0] === "#") {
        const hex = entity[1]?.toLowerCase() === "x";
        const raw = entity.slice(hex ? 2 : 1);
        const code = Number.parseInt(raw, hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      return named[entity.toLowerCase()] ?? `&${entity};`;
    },
  );
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function htmlToMarkdown(html: string): string {
  let value = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|canvas)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${stripTags(t)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${stripTags(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${stripTags(t)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${stripTags(t)}`)
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href, text) => {
        const label = stripTags(text) || href;
        return `[${label}](${decodeHtmlEntities(href)})`;
      },
    )
    .replace(/<\/(p|div|section|article|main|header|footer|nav|table|tr|ul|ol)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");

  value = decodeHtmlEntities(value)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return value;
}

export async function fetchWebPage(input: string): Promise<DirectWebPage> {
  const initialUrl = normalizePublicHttpUrl(input);
  const { response, text, url } = await fetchWithSafeRedirects(initialUrl);
  const contentType = response.headers.get("content-type") ?? undefined;
  const looksHtml = !contentType || /html|xhtml/i.test(contentType);
  const html = looksHtml ? text : `<pre>${text}</pre>`;
  const titleMatch = looksHtml ? text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) : null;
  return {
    url: url.toString(),
    title: titleMatch ? stripTags(titleMatch[1]) : undefined,
    contentType,
    html,
    markdown: looksHtml ? htmlToMarkdown(text) : text.trim(),
  };
}

function decodeDuckDuckGoUrl(rawHref: string): string | null {
  const href = decodeHtmlEntities(rawHref);
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    // Ignore malformed result links.
  }
  return null;
}

export async function searchWeb(
  query: string,
  limit = 8,
): Promise<DirectSearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const { text } = await fetchWithSafeRedirects(url, {
    timeoutMs: 20_000,
    maxBytes: 1_500_000,
  });

  const results: DirectSearchResult[] = [];
  const resultRe =
    /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>|<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>)([\s\S]*?)<\/(?:a|div)>/gi;

  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(text)) && results.length < limit) {
    const target = decodeDuckDuckGoUrl(match[1]);
    if (!target) continue;
    results.push({
      title: stripTags(match[2]),
      url: target,
      snippet: stripTags(match[3]),
    });
  }

  // DuckDuckGo occasionally changes snippet markup. Fall back to title/link
  // extraction so the tool still returns useful navigation targets.
  if (results.length === 0) {
    const linkRe =
      /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkRe.exec(text)) && results.length < limit) {
      const target = decodeDuckDuckGoUrl(match[1]);
      if (!target) continue;
      results.push({ title: stripTags(match[2]), url: target, snippet: "" });
    }
  }

  return results;
}

export async function capturePublicWebScreenshot(
  input: string,
): Promise<string | undefined> {
  const url = normalizePublicHttpUrl(input);
  await assertPublicHost(url);

  const crawlSession = session.fromPartition("dyad-web-crawl", { cache: false });
  crawlSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );

  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: {
      session: crawlSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
    },
  });

  try {
    await Promise.race([
      window.loadURL(url.toString(), { userAgent: USER_AGENT }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Screenshot navigation timed out")),
          30_000,
        ),
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const image = await window.webContents.capturePage();
    return image.toDataURL();
  } catch (error) {
    logger.warn("Best-effort web screenshot failed", error);
    return undefined;
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}
