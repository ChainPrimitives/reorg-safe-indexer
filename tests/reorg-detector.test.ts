import { describe, it, expect, beforeEach } from "vitest";
import { ReorgDetector } from "../src/reorg-detector";
import { MemoryStorage } from "../src/storage/memory";
import { noopLogger } from "../src/utils";
import { MockProvider } from "./helpers/mock-provider";
import type { RetryConfig } from "../src/types";

const RETRY: RetryConfig = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

async function seedStore(
  store: MemoryStorage,
  provider: MockProvider,
  from: number,
  to: number,
): Promise<void> {
  for (let i = from; i <= to; i++) {
    const b = await provider.getBlock(i);
    await store.saveBlock({
      number: b!.number,
      hash: b!.hash!,
      parentHash: b!.parentHash,
      timestamp: b!.timestamp,
      eventCount: 0,
    });
  }
}

describe("ReorgDetector", () => {
  let provider: MockProvider;
  let store: MemoryStorage;
  let detector: ReorgDetector;

  beforeEach(async () => {
    provider = new MockProvider();
    store = new MemoryStorage();
    await store.init();
    detector = new ReorgDetector(provider.asProvider(), store, {
      reorgDepth: 128,
      retry: RETRY,
      logger: noopLogger,
    });
  });

  it("returns null on an empty store", async () => {
    expect(await detector.detectReorg()).toBeNull();
  });

  it("returns null when stored hashes match the chain", async () => {
    provider.fillChain(1, 10, "a");
    await seedStore(store, provider, 1, 10);
    expect(await detector.detectReorg()).toBeNull();
  });

  it("detects a shallow reorg and returns the first reorged block", async () => {
    provider.fillChain(1, 10, "a");
    await seedStore(store, provider, 1, 10);

    // Chain reorgs blocks 8..10 with a new salt; 1..7 unchanged.
    provider.reorg(8, 10, "b");

    const rollbackFrom = await detector.detectReorg();
    expect(rollbackFrom).toBe(8);
  });

  it("walks back across multiple reorged blocks to the fork point", async () => {
    provider.fillChain(1, 20, "a");
    await seedStore(store, provider, 1, 20);

    provider.reorg(15, 20, "c"); // 6-block reorg
    const rollbackFrom = await detector.detectReorg();
    expect(rollbackFrom).toBe(15);
  });

  it("caps rollback at reorgDepth for very deep reorgs", async () => {
    const shallow = new ReorgDetector(provider.asProvider(), store, {
      reorgDepth: 5,
      retry: RETRY,
      logger: noopLogger,
    });
    provider.fillChain(1, 20, "a");
    await seedStore(store, provider, 1, 20);

    provider.reorg(1, 20, "z"); // everything changed
    const rollbackFrom = await shallow.detectReorg();
    expect(rollbackFrom).toBe(15); // latest(20) - depth(5)
  });

  it("rolls back storage to the fork point", async () => {
    provider.fillChain(1, 10, "a");
    await seedStore(store, provider, 1, 10);

    const rolled = await detector.rollback(8);
    expect(rolled).toBe(3); // blocks 8,9,10
    expect(await store.getLatestBlock()).toBe(7);
    expect(await store.getBlock(8)).toBeNull();
  });

  it("rollback is a no-op past the stored head", async () => {
    provider.fillChain(1, 5, "a");
    await seedStore(store, provider, 1, 5);
    expect(await detector.rollback(99)).toBe(0);
    expect(await store.getLatestBlock()).toBe(5);
  });
});
