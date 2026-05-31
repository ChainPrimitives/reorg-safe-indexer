import type { Logger, RetryConfig } from "./types";

/** A logger that discards all output. Used as the default. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Sleep for `ms` milliseconds. Resolves early if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Recursively convert BigInt values to strings so the result is safe to pass
 * to `JSON.stringify`. Handles nested objects, arrays, and ethers `Result`
 * tuples. Leaves all other values untouched.
 */
export function serializeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeBigInts);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = serializeBigInts(val);
    }
    return out;
  }
  return value;
}

/** Determine whether a thrown RPC error is worth retrying. */
export function isRetryableError(error: unknown): boolean {
  const err = error as { code?: string | number; message?: string };
  const code = err?.code;
  if (
    code === "NETWORK_ERROR" ||
    code === "TIMEOUT" ||
    code === "SERVER_ERROR" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  const message = (err?.message ?? "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("429")
  );
}

/**
 * Run an async operation with exponential backoff on retryable errors.
 *
 * @throws the last error if all attempts fail or the error is not retryable.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  logger: Logger,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === config.maxRetries) {
        throw error;
      }
      const delay = Math.min(
        config.baseDelayMs * 2 ** (attempt - 1),
        config.maxDelayMs,
      );
      // Add jitter (±20%) to avoid thundering-herd retries.
      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      const wait = Math.max(0, Math.round(delay + jitter));
      logger.warn(
        `[${label}] attempt ${attempt}/${config.maxRetries} failed, retrying in ${wait}ms`,
        error,
      );
      await sleep(wait, signal);
    }
  }
  throw lastError;
}

/** Lowercase an EVM address for consistent map keys / comparisons. */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}
