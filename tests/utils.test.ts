import { describe, it, expect, vi } from "vitest";
import {
  serializeBigInts,
  isRetryableError,
  withRetry,
  normalizeAddress,
  noopLogger,
} from "../src/utils";
import type { RetryConfig } from "../src/types";

const RETRY: RetryConfig = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 };

describe("serializeBigInts", () => {
  it("converts top-level bigints", () => {
    expect(serializeBigInts(10n)).toBe("10");
  });

  it("recurses into objects and arrays", () => {
    const input = { a: 1n, b: [2n, { c: 3n }], d: "x" };
    expect(serializeBigInts(input)).toEqual({
      a: "1",
      b: ["2", { c: "3" }],
      d: "x",
    });
  });

  it("leaves non-bigint primitives alone", () => {
    expect(serializeBigInts(null)).toBeNull();
    expect(serializeBigInts(true)).toBe(true);
    expect(serializeBigInts("s")).toBe("s");
  });

  it("produces JSON-serializable output", () => {
    expect(() =>
      JSON.stringify(serializeBigInts({ v: 99999999999999999999n })),
    ).not.toThrow();
  });
});

describe("isRetryableError", () => {
  it("flags known network codes", () => {
    expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryableError({ code: "NETWORK_ERROR" })).toBe(true);
  });

  it("flags rate-limit messages", () => {
    expect(isRetryableError({ message: "429 Too Many Requests" })).toBe(true);
    expect(isRetryableError({ message: "socket hang up" })).toBe(true);
  });

  it("does not flag arbitrary errors", () => {
    expect(isRetryableError({ message: "invalid argument" })).toBe(false);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(op, RETRY, noopLogger, "test");
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors then succeeds", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce({ code: "ETIMEDOUT" })
      .mockResolvedValue("ok");
    const result = await withRetry(op, RETRY, noopLogger, "test");
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const op = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(withRetry(op, RETRY, noopLogger, "test")).rejects.toThrow(
      "fatal",
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const op = vi.fn().mockRejectedValue({ code: "ETIMEDOUT" });
    await expect(
      withRetry(op, RETRY, noopLogger, "test"),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(op).toHaveBeenCalledTimes(3);
  });
});

describe("normalizeAddress", () => {
  it("lowercases", () => {
    expect(normalizeAddress("0xABCdef")).toBe("0xabcdef");
  });
});
