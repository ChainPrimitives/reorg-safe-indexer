import type {
  StorageBackend,
  BlockRecord,
  IndexedEvent,
  EventFilter,
} from "../types";
import { serializeBigInts, normalizeAddress } from "../utils";

/**
 * Minimal structural type for the slice of `better-sqlite3` we use.
 * Avoids a hard type dependency on the optional package.
 */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

interface BlockRow {
  number: number;
  hash: string;
  parent_hash: string;
  timestamp: number;
  event_count: number;
}

interface EventRow {
  id: string;
  block_number: number;
  block_hash: string;
  transaction_hash: string;
  log_index: number;
  contract_address: string;
  event_name: string;
  args: string;
  timestamp: number;
  removed: number;
}

/**
 * SQLite storage backend backed by `better-sqlite3`.
 *
 * `better-sqlite3` is an optional peer dependency; install it separately:
 * `npm install better-sqlite3`.
 */
export class SqliteStorage implements StorageBackend {
  private db: SqliteDatabase;

  /**
   * @param filename Path to the SQLite file, or `":memory:"` for an
   *   ephemeral in-memory database.
   * @param database Optionally inject a pre-constructed `better-sqlite3`
   *   instance (useful for testing or custom pragmas).
   */
  constructor(filename: string, database?: SqliteDatabase) {
    if (database) {
      this.db = database;
    } else {
      let Database: new (file: string) => SqliteDatabase;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        Database = require("better-sqlite3");
      } catch {
        throw new Error(
          "SqliteStorage requires the optional peer dependency 'better-sqlite3'. " +
            "Install it with: npm install better-sqlite3",
        );
      }
      this.db = new Database(filename);
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_blocks (
        number       INTEGER PRIMARY KEY,
        hash         TEXT NOT NULL,
        parent_hash  TEXT NOT NULL,
        timestamp    INTEGER NOT NULL,
        event_count  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS indexed_events (
        id                TEXT PRIMARY KEY,
        block_number      INTEGER NOT NULL,
        block_hash        TEXT NOT NULL,
        transaction_hash  TEXT NOT NULL,
        log_index         INTEGER NOT NULL,
        contract_address  TEXT NOT NULL,
        event_name        TEXT NOT NULL,
        args              TEXT NOT NULL,
        timestamp         INTEGER NOT NULL,
        removed           INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_events_block ON indexed_events(block_number);
      CREATE INDEX IF NOT EXISTS idx_events_contract ON indexed_events(contract_address);
      CREATE INDEX IF NOT EXISTS idx_events_name ON indexed_events(event_name);
    `);
  }

  async saveBlock(block: BlockRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO indexed_blocks (number, hash, parent_hash, timestamp, event_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET
           hash = excluded.hash,
           parent_hash = excluded.parent_hash,
           timestamp = excluded.timestamp,
           event_count = excluded.event_count`,
      )
      .run(
        block.number,
        block.hash,
        block.parentHash,
        block.timestamp,
        block.eventCount,
      );
  }

  async getBlock(blockNumber: number): Promise<BlockRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM indexed_blocks WHERE number = ?")
      .get(blockNumber) as BlockRow | undefined;
    if (!row) return null;
    return {
      number: row.number,
      hash: row.hash,
      parentHash: row.parent_hash,
      timestamp: row.timestamp,
      eventCount: row.event_count,
    };
  }

  async getLatestBlock(): Promise<number> {
    const row = this.db
      .prepare("SELECT MAX(number) AS num FROM indexed_blocks")
      .get() as { num: number | null } | undefined;
    return row?.num ?? 0;
  }

  async saveEvents(events: IndexedEvent[]): Promise<void> {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO indexed_events
         (id, block_number, block_hash, transaction_hash, log_index,
          contract_address, event_name, args, timestamp, removed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    const insertMany = this.db.transaction((rows: IndexedEvent[]) => {
      for (const event of rows) {
        stmt.run(
          event.id,
          event.blockNumber,
          event.blockHash,
          event.transactionHash,
          event.logIndex,
          normalizeAddress(event.contractAddress),
          event.eventName,
          JSON.stringify(serializeBigInts(event.args)),
          event.timestamp,
          event.removed ? 1 : 0,
        );
      }
    });
    insertMany(events);
  }

  async deleteEventsFromBlock(blockNumber: number): Promise<void> {
    this.db
      .prepare("DELETE FROM indexed_events WHERE block_number = ?")
      .run(blockNumber);
  }

  async deleteBlocksFrom(blockNumber: number): Promise<void> {
    const tx = this.db.transaction((from: number) => {
      this.db
        .prepare("DELETE FROM indexed_events WHERE block_number >= ?")
        .run(from);
      this.db.prepare("DELETE FROM indexed_blocks WHERE number >= ?").run(from);
    });
    tx(blockNumber);
  }

  async getEvents(filter: EventFilter = {}): Promise<IndexedEvent[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.eventName) {
      clauses.push("event_name = ?");
      params.push(filter.eventName);
    }
    if (filter.contractAddress) {
      clauses.push("contract_address = ?");
      params.push(normalizeAddress(filter.contractAddress));
    }
    if (filter.fromBlock !== undefined) {
      clauses.push("block_number >= ?");
      params.push(filter.fromBlock);
    }
    if (filter.toBlock !== undefined) {
      clauses.push("block_number <= ?");
      params.push(filter.toBlock);
    }

    let sql = "SELECT * FROM indexed_events";
    if (clauses.length > 0) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY block_number ASC, log_index ASC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += " OFFSET ?";
        params.push(filter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private rowToEvent(row: EventRow): IndexedEvent {
    return {
      id: row.id,
      blockNumber: row.block_number,
      blockHash: row.block_hash,
      transactionHash: row.transaction_hash,
      logIndex: row.log_index,
      contractAddress: row.contract_address,
      eventName: row.event_name,
      args: JSON.parse(row.args) as Record<string, unknown>,
      timestamp: row.timestamp,
      removed: row.removed === 1,
    };
  }
}
