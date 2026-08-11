import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("secret_storage");

// Tags plaintext-fallback blobs.
export const PLAINTEXT_PREFIX = "plain:";

// Tags AES-256-GCM blobs encrypted with the app-local key file.
// This is the ONLY encryption path — safeStorage/Keychain is never used.
export const AESGCM_PREFIX = "aesgcm:";

// File that holds the local encryption key. Mode 0600: only the owner
// can read it, so at-rest credentials are encrypted without requiring
// macOS Keychain access.
const LOCAL_KEY_FILE_NAME = ".dyad-encryption-key";

let localKeyCache: Buffer | null | undefined;

function localKeyPath(): string {
  try {
    return path.join(app.getPath("userData"), LOCAL_KEY_FILE_NAME);
  } catch {
    return path.join(".", LOCAL_KEY_FILE_NAME);
  }
}

function getOrCreateLocalKey(): Buffer | null {
  if (localKeyCache !== undefined) {
    return localKeyCache;
  }
  const keyPath = localKeyPath();
  try {
    if (fs.existsSync(keyPath)) {
      const key = fs.readFileSync(keyPath);
      if (key.length === 32) {
        localKeyCache = key;
        return key;
      }
      logger.warn(
        `Local encryption key file has an invalid length (${key.length}); regenerating`,
      );
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    localKeyCache = key;
    return key;
  } catch (error) {
    logger.warn("Could not create local encryption key; falling back to plaintext", error);
    localKeyCache = null;
    return null;
  }
}

function encryptAesGcm(plaintext: string): string {
  const key = getOrCreateLocalKey();
  if (!key) {
    return "";
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptAesGcm(stored: string): string | null {
  const key = getOrCreateLocalKey();
  if (!key) {
    return null;
  }
  try {
    const raw = Buffer.from(stored, "base64");
    if (raw.length < 28) {
      return null;
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    logger.warn("AES-GCM decryption failed for a stored secret", error);
    return null;
  }
}

/**
 * True when secrets can be encrypted at rest using the app-local AES key.
 * Never checks safeStorage/Keychain.
 */
export function isSecretEncryptionAvailable(): boolean {
  return getOrCreateLocalKey() !== null;
}

/**
 * Encrypt using AES-GCM local key. Falls back to base64 plaintext
 * when the local key file is unavailable.
 */
export function encryptToString(plaintext: string): string {
  const aesgcm = encryptAesGcm(plaintext);
  if (aesgcm) {
    return AESGCM_PREFIX + aesgcm;
  }
  logger.warn(
    "Local AES encryption unavailable; secret written as plaintext",
  );
  return PLAINTEXT_PREFIX + Buffer.from(plaintext, "utf8").toString("base64");
}

/**
 * Decrypt from AES-GCM or plaintext format. Legacy safeStorage ciphertext
 * (untagged base64) is treated as plaintext — callers validate the result.
 */
export function decryptFromString(stored: string): string {
  if (stored.startsWith(AESGCM_PREFIX)) {
    const decrypted = decryptAesGcm(stored.slice(AESGCM_PREFIX.length));
    if (decrypted !== null) {
      return decrypted;
    }
    return Buffer.from(stored, "base64").toString("utf8");
  }
  if (stored.startsWith(PLAINTEXT_PREFIX)) {
    return Buffer.from(
      stored.slice(PLAINTEXT_PREFIX.length),
      "base64",
    ).toString("utf8");
  }
  // Untagged blob — treat as plaintext (or legacy safeStorage that can't be decrypted)
  const buf = Buffer.from(stored, "base64");
  try {
    return buf.toString("utf8");
  } catch (err) {
    logger.warn("Could not decode stored secret as UTF-8", err);
    return stored;
  }
}

export function encryptSecretMap(
  value: Record<string, string> | null | undefined,
): string | null {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }
  return encryptToString(JSON.stringify(value));
}

export function decryptSecretMap(
  stored: string | null | undefined,
): Record<string, string> | null {
  if (!stored) {
    return null;
  }
  const json = decryptFromString(stored);
  if (!json) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((v) => typeof v === "string")
  ) {
    return null;
  }
  return parsed as Record<string, string>;
}

export type ServerSecretRead =
  | { status: "ok"; value: Record<string, string> | null }
  | { status: "unreadable" };

export function readServerSecretMap(
  encrypted: string | null | undefined,
  plaintext: Record<string, string> | null | undefined,
): ServerSecretRead {
  if (!encrypted) {
    return { status: "ok", value: plaintext ?? null };
  }
  const decrypted = decryptSecretMap(encrypted);
  if (decrypted) {
    return { status: "ok", value: decrypted };
  }
  if (plaintext) {
    logger.warn(
      "Could not read an encrypted MCP secret; falling back to the plaintext column",
    );
    return { status: "ok", value: plaintext };
  }
  logger.error(
    "Could not read an encrypted MCP secret and no plaintext fallback exists",
  );
  return { status: "unreadable" };
}
