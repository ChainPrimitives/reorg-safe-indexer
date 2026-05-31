import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStorage } from "../../src/storage/sqlite";
import type { BlockRecord, IndexedEvent } from "../../src/types";

function block(n: number): BlockRecord {
  return {
    number: n,
    hash: `0xhash${n}`,
    parentHash: `0xhash${n - 1}`,
    timestamp: 1000 + n,
    eventCount: 0,
  };
}

function event(n: number, idx: number, name = "Transfer"): IndexedEvent {
  return {
    id: `0xtx${n}_${idx}-${idx}`,
    blockNumber: n,
    blockHash: `0xhash${n}`,
    transactionHash: `0xtx${n}_${idx}`,
    logIndex: idx,
    contractAddress: "0xAbCdEf0000000000000000000000000000000001",
    eventName: name,
    args: { value: 123456789012345678901234567890n, to: "0xabc" },
    timestamp: 1000 + n,
    removed: false,
  };
}

describe("SqliteStorage (in-memory)", () => {
  let store: SqliteStorage;

  beforeEach(async () => {
    store = new SqliteStorage(":memory:");
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it("starts empty", async () => {
    expect(await store.getLatestBlock()).toBe(0);
  });

  it("upserts blocks", async () => {
    await store.saveBlock(block(5));
    await store.saveBlock({ ...block(5), hash: "0xnewhash" });
    const got = await store.getBlock(5);
    expect(got?.hash).toBe("0xnewhash");
    expect(await store.getLatestBlock()).toBe(5);
  });

  it("persists bigint args as decimal strings", async () => {
    await store.saveEvents([event(1, 0)]);
    const [e] = await store.getEvents();
    expect(e!.args.value).toBe("123456789012345678901234567890");
  });

  it("is idempotent on event id", async () => {
    await store.saveEvents([event(1, 0)]);
    await store.saveEvents([event(1, 0)]);
    expect(await store.getEvents()).toHaveLength(1);
  });

  it("filters and paginates", async () => {
    await store.saveEvents([
      event(1, 0, "Transfer"),
      event(2, 0, "Approval"),
      event(3, 0, "Transfer"),
    ]);
    expect(await store.getEvents({ eventName: "Transfer" })).toHaveLength(2);
    const page = await store.getEvents({ limit: 1, offset: 1 });
    expect(page[0]!.blockNumber).toBe(2);
  });

  it("rolls back blocks and events together", async () => {
    for (let i = 1; i <= 3; i++) {
      await store.saveBlock(block(i));
      await store.saveEvents([event(i, 0)]);
    }
    await store.deleteBlocksFrom(2);
    expect(await store.getLatestBlock()).toBe(1);
    expect(await store.getEvents()).toHaveLength(1);
    expect(await store.getBlock(3)).toBeNull();
  });
});
