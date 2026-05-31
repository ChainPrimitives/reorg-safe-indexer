import { describe, it, expect, beforeEach } from "vitest";
import { ReorgSafeIndexer } from "../src/indexer";
import { MemoryStorage } from "../src/storage/memory";
import { MockProvider } from "./helpers/mock-provider";
import {
  buildTransferLog,
  TRANSFER_ABI,
  ADDR_USDC,
  ADDR_ALICE,
  ADDR_BOB,
} from "./helpers/build-log";
import type { IndexedEvent } from "../src/types";

function makeIndexer(provider: MockProvider, storage: MemoryStorage) {
  return new ReorgSafeIndexer({
    provider: provider.asProvider(),
    storage,
    confirmations: 2,
    startBlock: 1,
    batchSize: 5,
    pollInterval: 10,
    reorgDepth: 64,
    contracts: [
      {
        name: "USDC",
        address: ADDR_USDC,
        abi: TRANSFER_ABI,
        events: ["Transfer"],
      },
    ],
  });
}

describe("ReorgSafeIndexer", () => {
  let provider: MockProvider;
  let storage: MemoryStorage;

  beforeEach(async () => {
    provider = new MockProvider();
    storage = new MemoryStorage();
    await storage.init();
  });

  it("requires at least one contract", () => {
    expect(
      () =>
        new ReorgSafeIndexer({
          provider: provider.asProvider(),
          storage,
          contracts: [],
        }),
    ).toThrow(/at least one contract/);
  });

  it("indexes events only up to the safe head (confirmations)", async () => {
    provider.fillChain(1, 10, "a");
    provider.setHead(10);
    // confirmations=2 -> safe head = 8
    provider.addLog(
      buildTransferLog({
        blockNumber: 5,
        blockHash: provider.hashOf(5),
        txHash: "0xtxA",
        index: 0,
        address: ADDR_USDC,
        from: ADDR_ALICE,
        to: ADDR_BOB,
        value: 1000n,
      }),
    );
    provider.addLog(
      buildTransferLog({
        blockNumber: 9, // beyond safe head, must NOT be indexed
        blockHash: "0x",
        txHash: "0xtxB",
        index: 0,
        address: ADDR_USDC,
        from: ADDR_ALICE,
        to: ADDR_BOB,
        value: 2000n,
      }),
    );

    const indexer = makeIndexer(provider, storage);
    const safe = await indexer.tick();

    expect(safe).toBe(8);
    expect(await storage.getLatestBlock()).toBe(8);
    const events = await storage.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.blockNumber).toBe(5);
    expect(events[0]!.args.value).toBe(1000n);
  });

  it("dispatches decoded events to handlers", async () => {
    provider.fillChain(1, 10, "a");
    provider.setHead(10);
    provider.addLog(
      buildTransferLog({
        blockNumber: 3,
        blockHash: "0x",
        txHash: "0xtx1",
        index: 0,
        address: ADDR_USDC,
        from: ADDR_ALICE,
        to: ADDR_BOB,
        value: 42n,
      }),
    );

    const seen: IndexedEvent[] = [];
    const indexer = makeIndexer(provider, storage);
    indexer.on("Transfer", async (e) => {
      seen.push(e);
    });

    await indexer.tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.eventName).toBe("Transfer");
    expect(seen[0]!.args.from?.toString().toLowerCase()).toBe(
      ADDR_ALICE.toLowerCase(),
    );
    expect(seen[0]!.args.value).toBe(42n);
  });

  it("does not advance past already-processed blocks on a second tick", async () => {
    provider.fillChain(1, 10, "a");
    provider.setHead(10);
    const indexer = makeIndexer(provider, storage);

    await indexer.tick();
    const callsAfterFirst = provider.getLogsCalls;

    // Nothing new mined -> no additional getLogs work.
    await indexer.tick();
    expect(provider.getLogsCalls).toBe(callsAfterFirst);
    expect(await storage.getLatestBlock()).toBe(8);
  });

  it("caches block headers within a range (one getBlock per block)", async () => {
    provider.fillChain(1, 10, "a");
    provider.setHead(10);
    // Two logs in the same block should not double-fetch the header.
    provider.addLog(
      buildTransferLog({
        blockNumber: 4,
        blockHash: "0x",
        txHash: "0xtx1",
        index: 0,
        address: ADDR_USDC,
        from: ADDR_ALICE,
        to: ADDR_BOB,
        value: 1n,
      }),
    );
    provider.addLog(
      buildTransferLog({
        blockNumber: 4,
        blockHash: "0x",
        txHash: "0xtx2",
        index: 1,
        address: ADDR_USDC,
        from: ADDR_ALICE,
        to: ADDR_BOB,
        value: 2n,
      }),
    );

    const indexer = makeIndexer(provider, storage);
    await indexer.tick();

    // Safe head = 8, blocks 1..8 each fetched exactly once for recording.
    expect(provider.getBlockCalls).toBe(8);
    expect(await storage.getEvents()).toHaveLength(2);
  });

  it("rolls back and re-indexes after a reorg", async () => {
    provider.fillChain(1, 12, "a");
    provider.setHead(12);
    // Log in block 6 on the original chain.
    provider.addLog(
      buildTransferLog({
        blockNumber: 6,
        blockHash: "0x",
        txHash: "0xOLD",
        index: 0,
        address: ADDR_USDC,
        from: ADDR_ALICE,
        to: ADDR_BOB,
        value: 100n,
      }),
    );

    const indexer = makeIndexer(provider, storage);
    await indexer.tick(); // safe head = 10, indexes block 6 log
    expect(await storage.getEvents()).toHaveLength(1);
    expect((await storage.getEvents())[0]!.transactionHash).toBe("0xOLD");

    // Reorg from block 6 onward; replace the log with a different tx.
    provider.reorg(6, 14, "b");
    provider.setHead(14);
    provider.clearLogs();
    provider.addLog(
      buildTransferLog({
        blockNumber: 6,
        blockHash: "0x",
        txHash: "0xNEW",
        index: 0,
        address: ADDR_USDC,
        from: ADDR_BOB,
        to: ADDR_ALICE,
        value: 200n,
      }),
    );

    let reorgInfo: { rollbackFrom: number; blocksRolledBack: number } | null =
      null;
    indexer.onLifecycle("reorg", (info) => {
      reorgInfo = info;
    });

    await indexer.tick(); // detects reorg at 6, rolls back, re-indexes

    expect(reorgInfo).not.toBeNull();
    expect(reorgInfo!.rollbackFrom).toBe(6);

    const events = await storage.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.transactionHash).toBe("0xNEW");
    expect(events[0]!.args.value).toBe(200n);
  });

  it("waits when the chain has not produced enough confirmations", async () => {
    provider.fillChain(1, 2, "a");
    provider.setHead(2); // safe head = 0 < startBlock(1)
    const indexer = makeIndexer(provider, storage);
    const safe = await indexer.tick();
    expect(safe).toBeNull();
    expect(await storage.getLatestBlock()).toBe(0);
  });

  it("isolates handler errors from persistence", async () => {
    provider.fillChain(1, 10, "a");
    provider.setHead(10);
    provider.addLog(
      buildTransferLog({
        blockNumber: 3,
        blockHash: "0x",
        txHash: "0xtx1",
        index: 0,
        address: ADDR_USDC,
        from: ADDR_ALICE,
        to: ADDR_BOB,
        value: 5n,
      }),
    );

    const indexer = makeIndexer(provider, storage);
    indexer.on("Transfer", async () => {
      throw new Error("handler boom");
    });
    // error listener prevents unhandled "error" emission
    indexer.onLifecycle("error", () => {});

    await expect(indexer.tick()).resolves.not.toThrow();
    // Event still persisted despite handler failure.
    expect(await storage.getEvents()).toHaveLength(1);
  });

  it("start()/stop() manage the running flag", async () => {
    provider.fillChain(1, 10, "a");
    provider.setHead(10);
    const indexer = makeIndexer(provider, storage);
    await indexer.start();
    expect(indexer.isRunning).toBe(true);
    await indexer.stop();
    expect(indexer.isRunning).toBe(false);
  });
});
