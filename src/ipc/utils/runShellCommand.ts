import { spawn } from "node:child_process";
import log from "electron-log";

const logger = log.scope("runShellCommand");

/**
 * Execute a small diagnostic command without a shell.
 *
 * This helper intentionally supports only whitespace-delimited argv because all
 * production callers are fixed diagnostic probes (node --version, pnpm
 * --version, which/where). Anything needing shell syntax belongs in a more
 * explicit execution boundary with its own consent and validation.
 */
export function runShellCommand(
  command: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$(){}><"'\\\r\n]/u.test(trimmed)) {
    logger.error(`Rejected unsupported diagnostic command: ${command}`);
    return Promise.resolve(null);
  }

  const [executable, ...args] = trimmed.split(/\s+/u);
  if (!executable) return Promise.resolve(null);

  logger.debug(`Running diagnostic command: ${executable} ${args.join(" ")}`);
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = spawn(executable, args, {
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data) => {
      output += data.toString();
      if (output.length > 64_000) output = output.slice(-64_000);
    });

    child.stderr?.on("data", (data) => {
      logger.warn(
        `Stderr from diagnostic command "${trimmed}": ${data.toString().trim()}`,
      );
    });

    child.once("error", (error) => {
      logger.error(`Error executing diagnostic command "${trimmed}":`, error.message);
      finish(null);
    });

    child.once("close", (code) => {
      if (code === 0) {
        finish(output.trim());
      } else {
        logger.error(`Diagnostic command "${trimmed}" failed with code ${code}`);
        finish(null);
      }
    });
  });
}
