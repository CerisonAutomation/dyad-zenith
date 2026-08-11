/**
 * Parallel tools utility for running multiple tool execution functions
 * with controlled concurrency, order preservation, and graceful failure handling.
 *
 * Designed for scenarios where multiple AI tool calls need to be executed
 * in parallel while maintaining result order and handling partial failures.
 */

import log from "electron-log";

const logger = log.scope("parallel-tools");

// ============================================================================
// Types
// ============================================================================

/**
 * A tool execution function that can be run in parallel.
 */
export type ToolExecutor<T = unknown> = () => Promise<T>;

/**
 * Configuration for a single tool execution.
 */
export interface ToolExecutionConfig<T = unknown> {
  /** The tool execution function */
  execute: ToolExecutor<T>;
  /** Unique identifier for the tool (for logging/debugging) */
  id: string;
  /** Optional timeout in milliseconds for this tool */
  timeoutMs?: number;
  /** Optional retry configuration */
  retry?: ToolRetryConfig;
  /** Optional label for human-readable logging */
  label?: string;
}

/**
 * Retry configuration for tool execution.
 */
export interface ToolRetryConfig {
  /** Maximum number of retries (default: 2) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 500) */
  baseDelay?: number;
  /** Maximum delay in ms (default: 5000) */
  maxDelay?: number;
  /** Jitter factor 0-1 (default: 0.1) */
  jitterFactor?: number;
}

/**
 * Result for a single tool execution.
 */
export interface ToolResult<T = unknown> {
  /** Whether the tool executed successfully */
  success: boolean;
  /** The result data if successful */
  data?: T;
  /** Error information if failed */
  error?: ToolError;
  /** The tool identifier */
  toolId: string;
  /** Execution time in milliseconds */
  durationMs?: number;
  /** Number of attempts made */
  attempts?: number;
}

/**
 * Error information for a failed tool execution.
 */
export interface ToolError {
  /** Error message */
  message: string;
  /** Whether the error was due to timeout */
  isTimeout?: boolean;
  /** Whether the error was due to the tool throwing */
  isToolError?: boolean;
  /** The original error if available */
  originalError?: Error;
}

/**
 * Options for parallelTools.
 */
export interface ParallelToolsOptions {
  /** Maximum number of concurrent tool executions (default: 4) */
  concurrency?: number;
  /** Default timeout in ms for all tools (default: 30000) */
  defaultTimeoutMs?: number;
  /** Default retry configuration for all tools */
  defaultRetry?: ToolRetryConfig;
  /** Whether to continue on individual failures (default: true) */
  continueOnFailure?: boolean;
  /** AbortSignal to cancel all tool executions */
  signal?: AbortSignal;
  /** Called when a tool starts executing */
  onToolStart?: (toolId: string) => void;
  /** Called when a tool completes (success or failure) */
  onToolComplete?: (result: ToolResult) => void;
  /** Called when all tools have completed */
  onAllComplete?: (results: ToolResult[]) => void;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_RETRY_CONFIG: Required<ToolRetryConfig> = {
  maxRetries: 2,
  baseDelay: 500,
  maxDelay: 5000,
  jitterFactor: 0.1,
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 4;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a timeout signal that aborts after specified milliseconds.
 */
function createTimeoutSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): AbortSignal {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  // If parent signal is already aborted, abort our controller
  if (parentSignal?.aborted) {
    controller.abort();
    clearTimeout(timeoutId);
  }

  // Listen for parent abort
  parentSignal?.addEventListener(
    "abort",
    () => {
      controller.abort();
      clearTimeout(timeoutId);
    },
    { once: true },
  );

  // Clean up timeout when signal aborts for any reason
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timeoutId);
    },
    { once: true },
  );

  return controller.signal;
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
function calculateBackoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  jitterFactor: number,
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = exponentialDelay * jitterFactor * Math.random();
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Execute a single tool with timeout and retry.
 */
async function executeSingleTool<T>(
  config: ToolExecutionConfig<T>,
  options: Pick<
    ParallelToolsOptions,
    "defaultTimeoutMs" | "defaultRetry" | "onToolStart" | "onToolComplete"
  >,
): Promise<ToolResult<T>> {
  const retryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.defaultRetry,
    ...config.retry,
  };
  const timeoutMs =
    config.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  // Notify tool start
  options.onToolStart?.(config.id);

  let attempts = 0;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    attempts = attempt + 1;

    const timeoutSignal = createTimeoutSignal(timeoutMs);

    try {
      // Execute the tool with timeout
      const result = await Promise.race([
        config.execute(),
        new Promise<never>((_, reject) => {
          timeoutSignal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
      ]);

      const durationMs = Date.now() - startTime;
      const toolResult: ToolResult<T> = {
        success: true,
        data: result,
        toolId: config.id,
        durationMs,
        attempts,
      };

      options.onToolComplete?.(toolResult);

      if (attempts > 1) {
        logger.info(
          `Tool ${config.id} succeeded after ${attempts} attempts (${durationMs}ms)`,
        );
      }

      return toolResult;
    } catch (error: unknown) {
      const isTimeout =
        error instanceof DOMException && error.name === "AbortError";
      const isToolError = error instanceof Error;

      const toolError: ToolError = {
        message: error instanceof Error ? error.message : String(error),
        isTimeout,
        isToolError,
        originalError: error instanceof Error ? error : undefined,
      };

      // Don't retry timeout errors or if we've exhausted retries
      if (attempt >= retryConfig.maxRetries || isTimeout) {
        const durationMs = Date.now() - startTime;
        const toolResult: ToolResult<T> = {
          success: false,
          error: toolError,
          toolId: config.id,
          durationMs,
          attempts,
        };

        options.onToolComplete?.(toolResult);

        logger.warn(
          `Tool ${config.id} failed after ${attempts} attempts (${durationMs}ms): ${toolError.message}`,
        );

        return toolResult;
      }

      // Calculate backoff delay
      const delay = calculateBackoffDelay(
        attempt,
        retryConfig.baseDelay,
        retryConfig.maxDelay,
        retryConfig.jitterFactor,
      );
      logger.warn(
        `Tool ${config.id} failed (attempt ${attempt + 1}/${retryConfig.maxRetries + 1}), ` +
          `retrying in ${Math.round(delay)}ms: ${toolError.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  const durationMs = Date.now() - startTime;
  return {
    success: false,
    error: { message: "Unknown error" },
    toolId: config.id,
    durationMs,
    attempts,
  };
}

// ============================================================================
// Main Export: parallelTools
// ============================================================================

/**
 * Execute multiple tool functions in parallel with controlled concurrency.
 *
 * Features:
 * - Configurable concurrency limit
 * - Per-tool timeout with AbortController
 * - Retry with exponential backoff for transient failures
 * - Results returned in the same order as input tools
 * - Graceful error handling - one tool failure doesn't kill others
 * - Support for AbortSignal to cancel all tools
 * - Callbacks for progress tracking
 *
 * @example
 * ```typescript
 * const results = await parallelTools([
 *   {
 *     id: "fetch-user",
 *     execute: () => fetchUser(userId),
 *     timeoutMs: 5000,
 *   },
 *   {
 *     id: "fetch-posts",
 *     execute: () => fetchPosts(userId),
 *     timeoutMs: 10000,
 *   },
 *   {
 *     id: "fetch-comments",
 *     execute: () => fetchComments(userId),
 *     timeoutMs: 8000,
 *   },
 * ], {
 *   concurrency: 2,
 *   onToolComplete: (result) => {
 *     console.log(`${result.toolId}: ${result.success ? "success" : "failed"}`);
 *   },
 * });
 *
 * // Results are in the same order as input tools
 * const [userResult, postsResult, commentsResult] = results;
 * ```
 *
 * @param tools - Array of tool execution configurations
 * @param options - Configuration options
 * @returns Array of results in the same order as input tools
 */
export async function parallelTools<T = unknown>(
  tools: ToolExecutionConfig<T>[],
  options: ParallelToolsOptions = {},
): Promise<ToolResult<T>[]> {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    defaultRetry,
    continueOnFailure = true,
    signal,
    onToolStart,
    onToolComplete,
    onAllComplete,
  } = options;

  if (tools.length === 0) {
    return [];
  }

  // Check if already aborted
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  logger.info(
    `Executing ${tools.length} tools with concurrency ${concurrency}: ` +
      `[${tools.map((t) => t.id).join(", ")}]`,
  );

  const startTime = Date.now();

  // Prepare results array with correct ordering
  const results: ToolResult<T>[] = Array.from({ length: tools.length });

  // Create an iterator over tools with indices
  const toolIterator = tools.map((tool, index) => ({ tool, index }));

  // Execute with controlled concurrency
  let currentIndex = 0;

  const executeNext = async (): Promise<void> => {
    while (currentIndex < toolIterator.length) {
      const { tool, index } = toolIterator[currentIndex++];

      try {
        const result = await executeSingleTool<T>(tool, {
          defaultTimeoutMs,
          defaultRetry,
          onToolStart,
          onToolComplete,
        });
        results[index] = result;

        if (!result.success && !continueOnFailure) {
          throw new Error(`Tool ${tool.id} failed: ${result.error?.message}`);
        }
      } catch (error) {
        const toolResult: ToolResult<T> = {
          success: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            isToolError: true,
            originalError: error instanceof Error ? error : undefined,
          },
          toolId: tool.id,
          attempts: 1,
        };
        results[index] = toolResult;

        onToolComplete?.(toolResult);

        if (!continueOnFailure) {
          throw error;
        }
      }
    }
  };

  // Create worker pool
  const workers = Array.from(
    { length: Math.min(concurrency, tools.length) },
    () => executeNext(),
  );

  // Wait for all workers to complete
  await Promise.all(workers);

  const totalDurationMs = Date.now() - startTime;
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  logger.info(
    `Completed ${tools.length} tools in ${totalDurationMs}ms: ` +
      `${successCount} succeeded, ${failCount} failed`,
  );

  onAllComplete?.(results);

  return results;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Execute multiple tools and return only successful results.
 * Failed tools are logged but not included in the output.
 */
export async function parallelToolsAll<T = unknown>(
  tools: ToolExecutionConfig<T>[],
  options: ParallelToolsOptions = {},
): Promise<T[]> {
  const results = await parallelTools<T>(tools, options);

  return results
    .filter(
      (result): result is ToolResult<T> & { success: true; data: T } =>
        result.success,
    )
    .map((result) => result.data);
}

/**
 * Execute multiple tools with a simple function array.
 * Convenience wrapper for when you don't need per-tool configuration.
 *
 * @example
 * ```typescript
 * const [users, posts, comments] = await parallelSimple([
 *   () => fetchUsers(),
 *   () => fetchPosts(),
 *   () => fetchComments(),
 * ], { concurrency: 2 });
 * ```
 */
export async function parallelSimple<T>(
  toolFunctions: ToolExecutor<T>[],
  options: Omit<ParallelToolsOptions, "onToolStart" | "onToolComplete"> & {
    /** Prefix for auto-generated tool IDs */
    idPrefix?: string;
  } = {},
): Promise<T[]> {
  const { idPrefix = "tool", ...parallelOptions } = options;

  const tools: ToolExecutionConfig<T>[] = toolFunctions.map(
    (execute, index) => ({
      id: `${idPrefix}-${index}`,
      execute,
    }),
  );

  return parallelToolsAll<T>(tools, parallelOptions);
}

/**
 * Execute tools in parallel with a map function that receives the index.
 * Useful when tools need to be constructed based on their position.
 *
 * @example
 * ```typescript
 * const results = await parallelMap(
 *   [1, 2, 3, 4, 5],
 *   (id) => ({
 *     id: `user-${id}`,
 *     execute: () => fetchUser(id),
 *   }),
 *   { concurrency: 3 },
 * );
 * ```
 */
export async function parallelMap<TInput, TOutput>(
  items: TInput[],
  mapper: (item: TInput, index: number) => ToolExecutionConfig<TOutput>,
  options: ParallelToolsOptions = {},
): Promise<ToolResult<TOutput>[]> {
  const tools = items.map((item, index) => mapper(item, index));
  return parallelTools<TOutput>(tools, options);
}

/**
 * Execute tools in parallel and return a summary of results.
 * Useful for batch operations where you need to know what succeeded/failed.
 */
export async function parallelToolsWithSummary<T = unknown>(
  tools: ToolExecutionConfig<T>[],
  options: ParallelToolsOptions = {},
): Promise<{
  results: ToolResult<T>[];
  succeeded: Array<{ toolId: string; data: T }>;
  failed: Array<{ toolId: string; error: ToolError }>;
  summary: {
    total: number;
    successCount: number;
    failCount: number;
    totalDurationMs: number;
  };
}> {
  const startTime = Date.now();
  const results = await parallelTools<T>(tools, options);
  const totalDurationMs = Date.now() - startTime;

  const succeeded = results
    .filter((r): r is ToolResult<T> & { success: true; data: T } => r.success)
    .map((r) => ({ toolId: r.toolId, data: r.data }));

  const failed = results
    .filter(
      (r): r is ToolResult<T> & { success: false; error: ToolError } =>
        !r.success,
    )
    .map((r) => ({ toolId: r.toolId, error: r.error! }));

  return {
    results,
    succeeded,
    failed,
    summary: {
      total: tools.length,
      successCount: succeeded.length,
      failCount: failed.length,
      totalDurationMs,
    },
  };
}
