import { describe, it, expect, beforeEach } from "vitest";
import { PostgresStorage } from "../../src/storage/postgres";
import type { BlockRecord, IndexedEvent } from "../../src/types";

interface Call {
  text: string;
  params: unknown[];
}

/**
 * A fake `pg.Pool` that records queries and serves canned responses, so we can
 * verify SQL/param generation without a live database.
 */
class FakePool {
  calls: Call[] = [];
  nextRows: unknown[][] = [];

  queueRows(rows: unknown[]): void {
    this.nextRows.push(rows);
  }

  async query(text: string, params: unknown[] = []) {
    this.calls.push({ text, params });
    const rows = this.nextRows.shift() ?? [];
    return { rows };
  }

  async end(): Promise<void> {}

  /** Last query's normalized text (collapsed whitespace). */
  lastSql(): string {
    return this.calls[this.calls.length - 1]!.text.replace(/\s+/g, " ").trim();
  }
}

function block(n: number): BlockRecord {
  return {
    number: n,
    hash: `0xhash${n}`,
    parentHash: `0xhash${n - 1}`,
    timestamp: 1000 + n,
    eventCount: 2,
  };
}

function event(n: number, idx: number): IndexedEvent {
  return {
    id: `0xtx${n}_${idx}-${idx}`,
    blockNumber: n,
    blockHash: `0xhash${n}`,
    transactionHash: `0xtx${n}_${idx}`,
    logIndex: idx,
    contractAddress: "0xAbCdEf0000000000000000000000000000000001",
    eventName: "Transfer",
    args: { value: 100n, to: "0xabc" },
    timestamp: 1000 + n,
    removed: false,
  };
}

describe("PostgresStorage (mocked pool)", () => {
  let pool: FakePool;
  let store: PostgresStorage;

  beforeEach(() => {
    pool = new FakePool();
    store = new PostgresStorage(pool as never);
  });

  it("creates tables on init", async () => {
    await store.init();
    expect(pool.lastSql()).toContain(
      "CREATE TABLE IF NOT EXISTS indexed_events",
    );
  });

  it("upserts blocks with ON CONFLICT", async () => {
    await store.saveBlock(block(5));
    const call = pool.calls[0]!;
    expect(call.text).toContain("ON CONFLICT (number) DO UPDATE");
    expect(call.params).toEqual([5, "0xhash5", "0xhash4", 1005, 2]);
  });

  it("normalizes addresses and serializes bigints when saving events", async () => {
    await store.saveEvents([event(1, 0)]);
    const call = pool.calls[0]!;
    // contract_address param lowercased
    expect(call.params[5]).toBe("0xabcdef0000000000000000000000000000000001");
    // args serialized with bigint -> string
    expect(call.params[7]).toBe(JSON.stringify({ value: "100", to: "0xabc" }));
    expect(call.text).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("builds a single multi-row insert for batches", async () => {
    await store.saveEvents([event(1, 0), event(1, 1)]);
    expect(pool.calls).toHaveLength(1);
    const sql = pool.lastSql();
    expect(sql).toContain("$10");
    expect(sql).toContain("$20"); // second row params
  });

  it("no-ops saveEvents on empty input", async () => {
    await store.saveEvents([]);
    expect(pool.calls).toHaveLength(0);
  });

  it("parses block rows from bigint-ish strings", async () => {
    pool.queueRows([
      {
        number: "12",
        hash: "0xh",
        parent_hash: "0xp",
        timestamp: "1700",
        event_count: 3,
      },
    ]);
    const b = await store.getBlock(12);
    expect(b).toEqual({
      number: 12,
      hash: "0xh",
      parentHash: "0xp",
      timestamp: 1700,
      eventCount: 3,
    });
  });

  it("returns 0 for getLatestBlock when empty", async () => {
    pool.queueRows([{ num: null }]);
    expect(await store.getLatestBlock()).toBe(0);
  });

  it("builds filtered getEvents query with positional params", async () => {
    pool.queueRows([]);
    await store.getEvents({
      eventName: "Transfer",
      contractAddress: "0xABC",
      fromBlock: 10,
      toBlock: 20,
      limit: 5,
      offset: 2,
    });
    const sql = pool.lastSql();
    expect(sql).toContain("event_name = $1");
    expect(sql).toContain("contract_address = $2");
    expect(sql).toContain("block_number >= $3");
    expect(sql).toContain("block_number <= $4");
    expect(sql).toContain("LIMIT $5");
    expect(sql).toContain("OFFSET $6");
    const call = pool.calls[0]!;
    expect(call.params).toEqual(["Transfer", "0xabc", 10, 20, 5, 2]);
  });

  it("maps event rows back, parsing string args", async () => {
    pool.queueRows([
      {
        id: "0xtx-0",
        block_number: "7",
        block_hash: "0xbh",
        transaction_hash: "0xtx",
        log_index: 0,
        contract_address: "0xabc",
        event_name: "Transfer",
        args: JSON.stringify({ value: "100" }),
        timestamp: "1700",
        removed: false,
      },
    ]);
    const [e] = await store.getEvents();
    expect(e!.blockNumber).toBe(7);
    expect(e!.args.value).toBe("100");
  });

  it("deletes events and blocks from a point", async () => {
    await store.deleteBlocksFrom(9);
    expect(pool.calls[0]!.text).toContain("DELETE FROM indexed_events");
    expect(pool.calls[1]!.text).toContain("DELETE FROM indexed_blocks");
    expect(pool.calls[0]!.params).toEqual([9]);
  });
});
