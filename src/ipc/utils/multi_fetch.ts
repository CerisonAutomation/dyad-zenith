/**
 * Multi-fetch utility for parallel API calls with configurable concurrency,
 * per-request timeouts, and retry with exponential backoff.
 *
 * Designed for scenarios where multiple API calls need to be made in parallel
 * but with controlled concurrency to avoid overwhelming servers.
 */

import log from "electron-log";

const logger = log.scope("multi-fetch");

// ============================================================================
// Types
// ============================================================================

/**
 * A single fetch request to be executed.
 */
export interface FetchRequest {
  /** The URL to fetch */
  url: RequestInfo | URL;
  /** Optional fetch options (headers, method, body, etc.) */
  options?: RequestInit;
  /** Optional timeout in milliseconds for this specific request */
  timeoutMs?: number;
  /** Optional retry configuration for this specific request */
  retry?: RetryConfig;
  /** Optional identifier for logging/debugging */
  id?: string;
}

/**
 * Retry configuration with exponential backoff.
 */
export interface RetryConfig {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelay?: number;
  /** Jitter factor 0-1 (default: 0.1 = 10%) */
  jitterFactor?: number;
  /** HTTP status codes to retry on (default: [429, 502, 503, 504]) */
  retryableStatusCodes?: number[];
}

/**
 * Result for a single fetch request.
 */
export interface FetchResult<T = unknown> {
  /** Whether the request succeeded */
  success: boolean;
  /** The response data if successful */
  data?: T;
  /** The raw Response object if available */
  response?: Response;
  /** Error information if failed */
  error?: FetchError;
  /** The original request identifier */
  requestId?: string;
}

/**
 * Error information for a failed fetch.
 */
export interface FetchError {
  /** Error message */
  message: string;
  /** HTTP status code if available */
  status?: number;
  /** Whether the error was due to timeout */
  isTimeout?: boolean;
  /** Whether the error was due to network issues */
  isNetworkError?: boolean;
  /** Number of attempts made */
  attempts?: number;
}

/**
 * Options for multiFetch.
 */
export interface MultiFetchOptions {
  /** Maximum number of concurrent requests (default: 6) */
  concurrency?: number;
  /** Default timeout in ms for all requests (default: 30000) */
  defaultTimeoutMs?: number;
  /** Default retry configuration for all requests */
  defaultRetry?: RetryConfig;
  /** Whether to continue on individual failures (default: true) */
  continueOnFailure?: boolean;
  /** AbortSignal to cancel all requests */
  signal?: AbortSignal;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  jitterFactor: 0.1,
  retryableStatusCodes: [429, 502, 503, 504],
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 6;

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
 * Check if an error is retryable based on status code.
 */
function isRetryableError(
  error: unknown,
  retryableStatusCodes: number[],
): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return false; // Timeout errors are not retryable
  }

  // Check for HTTP status in various error formats
  const status =
    (error as any)?.status ??
    (error as any)?.response?.status ??
    (error as any)?.statusCode;

  if (typeof status === "number" && retryableStatusCodes.includes(status)) {
    return true;
  }

  // Network errors (TypeError in fetch typically indicates network issue)
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }

  return false;
}

/**
 * Execute a single fetch request with timeout and retry.
 */
async function executeSingleFetch<T>(
  request: FetchRequest,
  options: Required<Pick<MultiFetchOptions, "defaultTimeoutMs">> &
    Pick<MultiFetchOptions, "defaultRetry">,
): Promise<FetchResult<T>> {
  const retryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.defaultRetry,
    ...request.retry,
  };
  const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs;

  let lastError: FetchError | undefined = undefined;
  let attempts = 0;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    attempts = attempt + 1;

    const timeoutSignal = createTimeoutSignal(timeoutMs);
    const controller = new AbortController();

    // Combine signals: abort if either parent or timeout aborts
    const combinedSignal = AbortSignal.any([timeoutSignal, controller.signal]);

    try {
      const response = await fetch(request.url, {
        ...request.options,
        signal: combinedSignal,
      });

      // Check for HTTP errors
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const error: FetchError = {
          message: `HTTP ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
          status: response.status,
          attempts,
        };

        // Check if we should retry
        if (
          attempt < retryConfig.maxRetries &&
          isRetryableError(
            { status: response.status },
            retryConfig.retryableStatusCodes,
          )
        ) {
          const delay = calculateBackoffDelay(
            attempt,
            retryConfig.baseDelay,
            retryConfig.maxDelay,
            retryConfig.jitterFactor,
          );
          logger.warn(
            `Request ${request.id ?? request.url} failed with ${response.status}, ` +
              `retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retryConfig.maxRetries + 1})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return {
          success: false,
          error,
          requestId: request.id,
          response,
        };
      }

      // Parse response as JSON by default, or return raw response
      let data: T;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        data = (await response.text()) as unknown as T;
      }

      return {
        success: true,
        data,
        response,
        requestId: request.id,
      };
    } catch (error: unknown) {
      const isTimeout =
        error instanceof DOMException && error.name === "AbortError";
      const isNetworkError = error instanceof TypeError;

      const fetchError: FetchError = {
        message: error instanceof Error ? error.message : String(error),
        isTimeout,
        isNetworkError,
        attempts,
      };
      lastError = fetchError;

      // Don't retry timeout errors or if we've exhausted retries
      if (
        attempt >= retryConfig.maxRetries ||
        isTimeout ||
        !isRetryableError(error, retryConfig.retryableStatusCodes)
      ) {
        return {
          success: false,
          error: fetchError,
          requestId: request.id,
        };
      }

      const delay = calculateBackoffDelay(
        attempt,
        retryConfig.baseDelay,
        retryConfig.maxDelay,
        retryConfig.jitterFactor,
      );
      logger.warn(
        `Request ${request.id ?? request.url} failed: ${fetchError.message}, ` +
          `retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retryConfig.maxRetries + 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  return {
    success: false,
    error: lastError ?? { message: "Unknown error" },
    requestId: request.id,
  };
}

// ============================================================================
// Main Export: multiFetch
// ============================================================================

/**
 * Execute multiple fetch requests in parallel with controlled concurrency.
 *
 * Features:
 * - Configurable concurrency limit to avoid overwhelming servers
 * - Per-request timeout with AbortController
 * - Retry with exponential backoff for transient failures
 * - Results returned in the same order as input requests
 * - Graceful error handling - one failure doesn't kill all requests
 * - Support for AbortSignal to cancel all requests
 *
 * @example
 * ```typescript
 * const results = await multiFetch([
 *   { url: "https://api.example.com/users/1", id: "user1" },
 *   { url: "https://api.example.com/users/2", id: "user2" },
 *   { url: "https://api.example.com/users/3", id: "user3" },
 * ], {
 *   concurrency: 3,
 *   defaultTimeoutMs: 5000,
 *   defaultRetry: { maxRetries: 2 },
 * });
 *
 * // Results are in the same order as requests
 * results.forEach((result, index) => {
 *   if (result.success) {
 *     console.log(`Request ${index}:`, result.data);
 *   } else {
 *     console.error(`Request ${index} failed:`, result.error);
 *   }
 * });
 * ```
 *
 * @param requests - Array of fetch requests to execute
 * @param options - Configuration options
 * @returns Array of results in the same order as input requests
 */
export async function multiFetch<T = unknown>(
  requests: FetchRequest[],
  options: MultiFetchOptions = {},
): Promise<FetchResult<T>[]> {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    defaultRetry,
    continueOnFailure = true,
    signal,
  } = options;

  if (requests.length === 0) {
    return [];
  }

  // Check if already aborted
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  logger.info(
    `Executing ${requests.length} requests with concurrency ${concurrency}`,
  );

  // Prepare results array with correct ordering
  const results: FetchResult<T>[] = Array.from({ length: requests.length });

  // Create an iterator over requests with indices
  const requestIterator = requests.map((request, index) => ({
    request,
    index,
  }));

  // Execute with controlled concurrency
  let currentIndex = 0;

  const executeNext = async (): Promise<void> => {
    while (currentIndex < requestIterator.length) {
      const { request, index } = requestIterator[currentIndex++];

      try {
        const result = await executeSingleFetch<T>(request, {
          defaultTimeoutMs,
          defaultRetry,
        });
        results[index] = result;

        if (!result.success && !continueOnFailure) {
          throw new Error(
            `Request ${request.id ?? request.url} failed: ${result.error?.message}`,
          );
        }
      } catch (error) {
        results[index] = {
          success: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            attempts: 1,
          },
          requestId: request.id,
        };

        if (!continueOnFailure) {
          throw error;
        }
      }
    }
  };

  // Create worker pool
  const workers = Array.from(
    { length: Math.min(concurrency, requests.length) },
    () => executeNext(),
  );

  // Wait for all workers to complete
  await Promise.all(workers);

  logger.info(
    `Completed ${requests.length} requests: ` +
      `${results.filter((r) => r.success).length} succeeded, ` +
      `${results.filter((r) => !r.success).length} failed`,
  );

  return results;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Execute multiple GET requests in parallel.
 *
 * @example
 * ```typescript
 * const results = await multiGet([
 *   "https://api.example.com/users/1",
 *   "https://api.example.com/users/2",
 * ], { headers: { Authorization: "Bearer token" } });
 * ```
 */
export async function multiGet<T = unknown>(
  urls: string[],
  options: Omit<MultiFetchOptions, "concurrency"> & {
    headers?: HeadersInit;
    concurrency?: number;
  } = {},
): Promise<FetchResult<T>[]> {
  const { headers, ...fetchOptions } = options;

  const requests: FetchRequest[] = urls.map((url, index) => ({
    url,
    id: `get-${index}`,
    options: { method: "GET", headers },
  }));

  return multiFetch<T>(requests, fetchOptions);
}

/**
 * Execute multiple POST requests in parallel.
 *
 * @example
 * ```typescript
 * const results = await multiPost([
 *   { url: "https://api.example.com/users", body: { name: "Alice" } },
 *   { url: "https://api.example.com/users", body: { name: "Bob" } },
 * ], { headers: { Authorization: "Bearer token" } });
 * ```
 */
export async function multiPost<T = unknown>(
  requests: Array<{ url: string; body: unknown; headers?: HeadersInit }>,
  options: Omit<MultiFetchOptions, "concurrency"> & {
    defaultHeaders?: HeadersInit;
    concurrency?: number;
  } = {},
): Promise<FetchResult<T>[]> {
  const { defaultHeaders, ...fetchOptions } = options;

  const fetchRequests: FetchRequest[] = requests.map((req, index) => ({
    url: req.url,
    id: `post-${index}`,
    options: {
      method: "POST",
      headers: {
        ...defaultHeaders,
        ...req.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    },
  }));

  return multiFetch<T>(fetchRequests, fetchOptions);
}

/**
 * Execute a batch of requests and return only successful results.
 * Failed requests are logged but not included in the output.
 */
export async function multiFetchAll<T = unknown>(
  requests: FetchRequest[],
  options: MultiFetchOptions = {},
): Promise<T[]> {
  const results = await multiFetch<T>(requests, options);

  return results
    .filter(
      (result): result is FetchResult<T> & { success: true; data: T } =>
        result.success,
    )
    .map((result) => result.data);
}
