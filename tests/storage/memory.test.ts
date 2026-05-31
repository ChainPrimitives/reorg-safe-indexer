import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStorage } from "../../src/storage/memory";
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
    args: { value: 100n },
    timestamp: 1000 + n,
    removed: false,
  };
}

describe("MemoryStorage", () => {
  let store: MemoryStorage;

  beforeEach(async () => {
    store = new MemoryStorage();
    await store.init();
  });

  it("returns 0 latest block when empty", async () => {
    expect(await store.getLatestBlock()).toBe(0);
  });

  it("saves and retrieves blocks", async () => {
    await store.saveBlock(block(5));
    const got = await store.getBlock(5);
    expect(got?.hash).toBe("0xhash5");
    expect(await store.getLatestBlock()).toBe(5);
  });

  it("tracks the max block number as latest", async () => {
    await store.saveBlock(block(3));
    await store.saveBlock(block(10));
    await store.saveBlock(block(7));
    expect(await store.getLatestBlock()).toBe(10);
  });

  it("saves events idempotently by id", async () => {
    await store.saveEvents([event(1, 0)]);
    await store.saveEvents([event(1, 0)]); // duplicate
    const all = await store.getEvents();
    expect(all).toHaveLength(1);
  });

  it("filters events by name, contract and block range", async () => {
    await store.saveEvents([
      event(1, 0, "Transfer"),
      event(2, 0, "Approval"),
      event(3, 0, "Transfer"),
    ]);
    expect(await store.getEvents({ eventName: "Transfer" })).toHaveLength(2);
    expect(await store.getEvents({ fromBlock: 2, toBlock: 3 })).toHaveLength(2);
    expect(
      await store.getEvents({
        contractAddress: "0xABCDEF0000000000000000000000000000000001",
      }),
    ).toHaveLength(3);
  });

  it("returns events ordered by block then log index", async () => {
    await store.saveEvents([event(2, 1), event(2, 0), event(1, 5)]);
    const all = await store.getEvents();
    expect(all.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [1, 5],
      [2, 0],
      [2, 1],
    ]);
  });

  it("supports limit and offset", async () => {
    await store.saveEvents([event(1, 0), event(2, 0), event(3, 0)]);
    const page = await store.getEvents({ limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]!.blockNumber).toBe(2);
  });

  it("deletes events for a single block", async () => {
    await store.saveEvents([event(1, 0), event(2, 0)]);
    await store.deleteEventsFromBlock(1);
    expect(await store.getEvents()).toHaveLength(1);
  });

  it("deletes blocks and events from a point onward", async () => {
    await store.saveBlock(block(1));
    await store.saveBlock(block(2));
    await store.saveBlock(block(3));
    await store.saveEvents([event(1, 0), event(2, 0), event(3, 0)]);

    await store.deleteBlocksFrom(2);

    expect(await store.getLatestBlock()).toBe(1);
    expect(await store.getBlock(2)).toBeNull();
    expect(await store.getEvents()).toHaveLength(1);
  });

  it("allows re-inserting an event id after its block is deleted", async () => {
    await store.saveEvents([event(1, 0)]);
    await store.deleteBlocksFrom(1);
    await store.saveEvents([event(1, 0)]);
    expect(await store.getEvents()).toHaveLength(1);
  });
});
