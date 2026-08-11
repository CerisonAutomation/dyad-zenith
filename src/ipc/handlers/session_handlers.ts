import { session } from "electron";
import fs from "node:fs/promises";
import log from "electron-log";
import { getTypeScriptCachePath } from "@/paths/paths";
import { createTypedHandler } from "./base";
import { systemContracts } from "../types/system";

const logger = log.scope("session_handlers");

export const registerSessionHandlers = () => {
  createTypedHandler(systemContracts.clearSessionData, async () => {
    const defaultAppSession = session.defaultSession;

    await defaultAppSession.clearStorageData({
      storages: ["cookies", "localstorage"],
    });
    logger.info(`All session data cleared for default session`);

    // Clear custom cache data (like tsbuildinfo)
    try {
      await fs.rm(getTypeScriptCachePath(), { recursive: true, force: true });
    } catch {
      // Directory might not exist
    }
  });
};
