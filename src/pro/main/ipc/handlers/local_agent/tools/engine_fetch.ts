/**
 * Engine removed (2026-08-11).
 * All cloud engine calls are eliminated. Use local model provider instead.
 */
import type { AgentContext } from "./types";

export interface EngineFetchOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

export async function engineFetch(
  _ctx: Pick<AgentContext, "dyadRequestId">,
  _endpoint: string,
  _options: EngineFetchOptions = {},
): Promise<Response> {
  return new Response(
    JSON.stringify({ error: "engine_removed", message: "Cloud engine calls are disabled. Use local tools instead." }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  );
}
